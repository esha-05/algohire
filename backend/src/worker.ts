import { Worker } from 'bullmq';
import pino from 'pino';
import { cfg } from './config';
import { pool, audit } from './db';
import { bull, maintQueue, publish } from './infra';
import { makePdf } from './pdf';
import { runScan } from './maint';

const log = pino();

// Safe to run any number of times for the same certificate (retries, crashes, sweeper re-queues).
async function deliver(id: string) {
  const { rows: [c] } = await pool.query('SELECT * FROM certificates WHERE id=$1', [id]);
  if (!c || c.status !== 'VALID' || c.delivery_status === 'SENT') return;       // cancelled or already done
  if (!c.pdf_ready) {
    await makePdf(c);
    await pool.query('UPDATE certificates SET pdf_ready=true WHERE id=$1', [id]);
    await audit(pool, 'system', 'cert.pdf_generated', { batchId: c.batch_id, certId: id }, { serial: c.serial });
  }
  await pool.query('UPDATE certificates SET delivery_attempts=delivery_attempts+1 WHERE id=$1', [id]);
  try {
    const res = await fetch(`${cfg.wa}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': id },     // provider de-duplicates retries by this key
      body: JSON.stringify({ to: c.phone, text: `Congratulations ${c.name}! Your ${c.course} certificate ${c.serial} is ready: ${cfg.publicUrl}/api/c/${c.token}/pdf` }),
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) throw new Error(`whatsapp http ${res.status}`);
  } catch (e: any) {
    await audit(pool, 'system', 'cert.whatsapp_failed', { batchId: c.batch_id, certId: id }, { error: e.message });
    throw e;                                                                       // BullMQ retries with exponential backoff
  }
  await pool.query(`UPDATE certificates SET delivery_status='SENT' WHERE id=$1`, [id]);
  await audit(pool, 'system', 'cert.whatsapp_sent', { batchId: c.batch_id, certId: id }, { serial: c.serial });
  const done = await pool.query(
    `UPDATE batches SET status='ISSUED', updated_at=now() WHERE id=$1 AND status='ISSUING'
     AND NOT EXISTS (SELECT 1 FROM certificates WHERE batch_id=$1 AND status='VALID' AND delivery_status<>'SENT')`, [c.batch_id]);
  if (done.rowCount) await audit(pool, 'system', 'batch.issued', { batchId: c.batch_id });
  publish('cert.sent', { batchId: c.batch_id, certId: id });
}

const issue = new Worker('issue', job => deliver(job.data.certId), { connection: bull, concurrency: Number(process.env.WORKER_CONCURRENCY || 10) });
issue.on('failed', async (job, err) => {
  if (!job || job.attemptsMade < (job.opts.attempts || 1)) return;                 // still has retries left
  const { rows: [c] } = await pool.query(`UPDATE certificates SET delivery_status='FAILED' WHERE id=$1 AND delivery_status<>'SENT' RETURNING batch_id`, [job.data.certId]);
  if (c) { await audit(pool, 'system', 'cert.delivery_failed', { batchId: c.batch_id, certId: job.data.certId }, { error: err.message }); publish('cert.failed', { batchId: c.batch_id }); }
  log.error({ certId: job.data.certId, err: err.message }, 'delivery gave up; sweeper will re-queue');
});
new Worker('maint', () => runScan(), { connection: bull });
maintQueue.upsertJobScheduler('scan', { every: 60000 }, { name: 'scan' }).catch(e => log.error(e));
process.on('SIGTERM', async () => { await issue.close(); process.exit(0); });
log.info('worker started');
