import { pool, audit } from './db';
import { cfg } from './config';
import { enqueueIssue, publish } from './infra';

// Runs every minute (single execution via a BullMQ job scheduler), also callable from the test hook.
export async function runScan() {
  // 1) SLA: batches sitting in a review stage too long are escalated (flag + audit + realtime event for the state office).
  const esc = await pool.query(
    `UPDATE batches SET escalated_at=now()
     WHERE status IN ('DISTRICT_REVIEW','QUALITY_REVIEW','STATE_REVIEW') AND escalated_at IS NULL
       AND stage_entered_at < now() - make_interval(secs => $1::double precision) RETURNING id, status`, [cfg.slaSeconds]);
  for (const b of esc.rows) {
    await audit(pool, 'system', 'batch.escalated', { batchId: b.id }, { stage: b.status, slaSeconds: cfg.slaSeconds });
    publish('batch.escalated', { batchId: b.id });
  }
  // 2) Sweeper: certificates still undelivered after 60s (Redis was down at enqueue time, job gave up, outage...) are re-queued.
  //    Capped per scan so a long WhatsApp outage drains as a trickle instead of a stampede.
  const stale = await pool.query(
    `SELECT id FROM certificates WHERE status='VALID' AND delivery_status<>'SENT' AND issued_at < now() - interval '60 seconds' LIMIT 1000`);
  if (stale.rowCount) await enqueueIssue(stale.rows.map(r => r.id));
  return { escalated: esc.rowCount, requeued: stale.rowCount };
}
