import express, { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import pino from 'pino';
import pinoHttp from 'pino-http';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { cfg } from './config';
import { pool, tx, audit } from './db';
import { redis, publish, enqueueIssue } from './infra';
import { runScan } from './maint';
import { HttpError, wrap, auth, signToken, verifyToken, STAGES, getBatch, validateCsv, saveCandidates } from './lib';

export const log = pino({ level: process.env.LOG_LEVEL || 'info' });
export const app = express();
app.set('trust proxy', 1);
app.use(helmet());
app.use(pinoHttp({ logger: log, redact: ['req.headers.authorization'], genReqId: (req: any) => req.headers['x-request-id'] || randomUUID() }) as any);
app.use(express.json({ limit: '1mb' }));
const r = express.Router();

// ---------- public ----------
r.get('/healthz', wrap(async (_q, res) => { await pool.query('SELECT 1'); await redis.ping(); res.json({ ok: true }); }));
r.get('/demo-users', wrap(async (_q, res) => res.json((await pool.query('SELECT id,name,role,district FROM users ORDER BY role,name')).rows)));
r.post('/auth/demo-login', wrap(async (req, res) => {
  if (!cfg.demoLogin) throw new HttpError(404, 'Not found');
  const { userId } = z.object({ userId: z.string() }).parse(req.body);
  const { rows: [u] } = await pool.query('SELECT * FROM users WHERE id=$1', [userId]);
  if (!u) throw new HttpError(404, 'Unknown user');
  res.json({ token: signToken({ sub: u.id, name: u.name, role: u.role, district: u.district, centre: u.centre_id }), user: { id: u.id, name: u.name, role: u.role } });
}));

// Public verification: reveals only status + masked holder name. Lookup is by an unguessable token, so serials cannot be enumerated.
async function limit(req: Request, _res: Response, next: NextFunction) {
  try {
    const k = `rl:${req.ip}:${Math.floor(Date.now() / 60000)}`;
    const n = await redis.incr(k);
    if (n === 1) await redis.expire(k, 70);
    if (n > 120) return next(new HttpError(429, 'Too many requests'));
  } catch { /* fail open: verification must keep working if Redis is down */ }
  next();
}
const mask = (n: string) => { const p = n.split(' '); return p.length > 1 ? `${p[0]} ${p[p.length - 1][0]}.` : p[0]; };
const view = (c: any) => ({ status: c.status, serial: c.serial, holder: mask(c.name), course: c.course, issuedAt: c.issued_at, cancelledAt: c.cancelled_at });
const TOKEN = /^[a-f0-9]{64}$/;

r.get('/verify/:token', limit, wrap(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const t = req.params.token;
  if (!TOKEN.test(t)) return res.status(404).json({ status: 'NOT_FOUND' });
  const key = `verify:${t}`;
  const hit = await redis.get(key).catch(() => null);
  if (hit) return res.json(JSON.parse(hit));
  const { rows: [c] } = await pool.query('SELECT serial,name,course,status,issued_at,cancelled_at FROM certificates WHERE token=$1', [t]);
  if (!c) return res.status(404).json({ status: 'NOT_FOUND' });
  const body = view(c);
  await redis.set(key, JSON.stringify(body), 'EX', 30, 'NX').catch(() => {});   // NX: never overwrite a cancellation tombstone
  res.json(body);
}));

r.get('/c/:token/pdf', limit, wrap(async (req, res) => {
  if (!TOKEN.test(req.params.token)) throw new HttpError(404, 'Not found');
  const { rows: [c] } = await pool.query('SELECT id,serial,status FROM certificates WHERE token=$1', [req.params.token]);
  if (!c) throw new HttpError(404, 'Not found');
  if (c.status !== 'VALID') throw new HttpError(410, 'This certificate has been cancelled');
  const file = path.join(cfg.storage, `${c.id}.pdf`);
  if (!fs.existsSync(file)) throw new HttpError(404, 'Certificate is still being prepared');
  res.download(file, `${c.serial}.pdf`);
}));

// ---------- realtime (SSE) ----------
const clients = new Set<Response>();
const sub = redis.duplicate();
sub.subscribe('events').catch(() => {});
sub.on('message', (_c, m) => clients.forEach(c => c.write(`data: ${m}\n\n`)));
r.get('/events', (req, res) => {
  try { verifyToken(String(req.query.token || '')); } catch { return res.sendStatus(401); }
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write(': ok\n\n');
  clients.add(res);
  const t = setInterval(() => res.write(': ka\n\n'), 20000);
  req.on('close', () => { clearInterval(t); clients.delete(res); });
});

// ---------- batches ----------
r.get('/batches', auth(), wrap(async (req, res) => {
  const u = req.user!;
  const { rows } = await pool.query(
    `SELECT b.*, ce.name AS centre_name, ce.district,
       (SELECT count(*) FROM approvals a WHERE a.batch_id=b.id AND a.round=b.round AND a.stage=b.status)::int AS approvals,
       EXISTS(SELECT 1 FROM approvals a WHERE a.batch_id=b.id AND a.round=b.round AND a.stage=b.status AND a.officer_id=$1) AS my_approved
     FROM batches b JOIN centres ce ON ce.id=b.centre_id
     WHERE ($2::text='CENTRE' AND b.centre_id=$3)
        OR ($2::text='DISTRICT' AND ce.district=$4 AND b.status<>'DRAFT')
        OR ($2::text IN ('QUALITY','STATE') AND b.status<>'DRAFT')
     ORDER BY b.updated_at DESC LIMIT 200`, [u.sub, u.role, u.centre ?? null, u.district ?? null]);
  res.json(rows);
}));

// Create + fill in ONE transaction: any bad row => 422 with every error, and nothing is stored.
r.post('/batches', auth('CENTRE'), wrap(async (req, res) => {
  const body = z.object({ title: z.string().trim().min(3).max(100), course: z.string().trim().min(2).max(80), csv: z.string().max(600000) }).parse(req.body);
  const id = await tx(async c => {
    const { rows, rule } = await validateCsv(c, body.course, body.csv);
    const { rows: [b] } = await c.query(`INSERT INTO batches(centre_id,title,course,status,created_by) VALUES($1,$2,$3,'DRAFT',$4) RETURNING id`,
      [req.user!.centre, body.title, body.course, req.user!.sub]);
    await saveCandidates(c, b.id, rows, rule.id);
    await audit(c, req.user!.sub, 'batch.created', { batchId: b.id }, { size: rows.length, ruleVersion: rule.version, ineligible: rows.filter((x: any) => !x.eligible).length });
    return b.id;
  });
  publish('batch.updated', { batchId: id });
  res.status(201).json({ id });
}));

r.put('/batches/:id/candidates', auth('CENTRE'), wrap(async (req, res) => {
  const { csv } = z.object({ csv: z.string().max(600000) }).parse(req.body);
  await tx(async c => {
    const b = await getBatch(c, req.params.id, req.user!, true);
    if (!['DRAFT', 'RETURNED'].includes(b.status)) throw new HttpError(409, `Cannot edit a batch that is ${b.status}`);
    const { rows, rule } = await validateCsv(c, b.course, csv);
    await saveCandidates(c, b.id, rows, rule.id);
    await audit(c, req.user!.sub, 'batch.candidates_replaced', { batchId: b.id }, { size: rows.length, ruleVersion: rule.version, ineligible: rows.filter((x: any) => !x.eligible).length });
  });
  publish('batch.updated', { batchId: req.params.id });
  res.json({ ok: true });
}));

r.post('/batches/:id/submit', auth('CENTRE'), wrap(async (req, res) => {
  await tx(async c => {
    const b = await getBatch(c, req.params.id, req.user!, true);
    if (!['DRAFT', 'RETURNED'].includes(b.status)) throw new HttpError(409, `Batch is already ${b.status}`);
    if (!b.size) throw new HttpError(400, 'Batch has no candidates');
    // Resubmission after a return starts a NEW round: earlier approvals are void because the content changed.
    const round = b.status === 'RETURNED' ? b.round + 1 : b.round;
    await c.query(`UPDATE batches SET status='DISTRICT_REVIEW', round=$2, stage_entered_at=now(), escalated_at=NULL, return_reason=NULL, updated_at=now() WHERE id=$1`, [b.id, round]);
    await audit(c, req.user!.sub, 'batch.submitted', { batchId: b.id }, { round, earlierApprovalsVoided: b.status === 'RETURNED' });
  });
  publish('batch.updated', { batchId: req.params.id });
  res.json({ ok: true });
}));

r.get('/batches/:id', auth(), wrap(async (req, res) => {
  const b = await getBatch(pool, req.params.id, req.user!);
  const q = (s: string, p: any[]) => pool.query(s, p).then(x => x.rows);
  const [candidates, certificates, approvals, timeline] = await Promise.all([
    q('SELECT id,name,phone,attendance,theory,practical,eligible,reasons,override_reason FROM candidates WHERE batch_id=$1 ORDER BY name', [b.id]),
    q('SELECT id,serial,name,status,delivery_status,delivery_attempts,token FROM certificates WHERE batch_id=$1 ORDER BY serial', [b.id]),
    q('SELECT officer_id,stage,created_at FROM approvals WHERE batch_id=$1 AND round=$2', [b.id, b.round]),
    q('SELECT ts,actor,action,cert_id,details FROM audit_log WHERE batch_id=$1 ORDER BY id LIMIT 1000', [b.id]),
  ]);
  res.json({ batch: b, candidates, certificates, approvals, timeline, rule: (await pool.query('SELECT * FROM course_rules WHERE id=$1', [b.rule_id])).rows[0] ?? null });
}));

// The core workflow. FOR UPDATE serialises concurrent decisions on one batch, so two simultaneous
// "approve" calls are processed one after the other and the batch advances exactly once.
r.post('/batches/:id/decision', auth('DISTRICT', 'QUALITY', 'STATE'), wrap(async (req, res) => {
  const body = z.object({ decision: z.enum(['APPROVE', 'RETURN', 'REJECT']), reason: z.string().trim().min(3).max(500).optional() }).parse(req.body);
  if (body.decision !== 'APPROVE' && !body.reason) throw new HttpError(400, 'A reason is required');
  const u = req.user!;
  const out = await tx(async c => {
    const b = await getBatch(c, req.params.id, u, true);
    const st = STAGES[b.status];
    if (!st) throw new HttpError(409, `Batch is ${b.status}; it is not awaiting a decision`);
    if (st.role !== u.role) throw new HttpError(403, `This step belongs to ${st.role}`);
    let next = b.status, certIds: string[] = [];
    if (body.decision === 'APPROVE') {
      const ins = await c.query('INSERT INTO approvals(batch_id,round,stage,officer_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [b.id, b.round, b.status, u.sub]);
      if (!ins.rowCount) throw new HttpError(409, 'You have already approved this batch at this step');
      await audit(c, u.sub, 'batch.approved', { batchId: b.id }, { stage: b.status, round: b.round });
      const n = (await c.query('SELECT count(*)::int AS n FROM approvals WHERE batch_id=$1 AND round=$2 AND stage=$3', [b.id, b.round, b.status])).rows[0].n;
      if (n >= st.need) {
        next = b.status === 'DISTRICT_REVIEW' ? (b.size >= cfg.qualityThreshold ? 'QUALITY_REVIEW' : 'STATE_REVIEW') : b.status === 'QUALITY_REVIEW' ? 'STATE_REVIEW' : 'ISSUING';
        if (next === 'ISSUING') {   // final approval: one certificate per candidate, serials from a DB sequence, same transaction
          const created = await c.query(
            `INSERT INTO certificates(serial,candidate_id,batch_id,name,phone,course,token)
             SELECT 'PSM-'||to_char(now(),'YYYY')||'-'||lpad(nextval('cert_serial_seq')::text,6,'0'), ca.id, $1::uuid, ca.name, ca.phone, $2::text,
                    replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-','')
             FROM candidates ca WHERE ca.batch_id=$1::uuid AND (ca.eligible OR ca.override_reason IS NOT NULL) ORDER BY ca.id RETURNING id`, [b.id, b.course]);
          certIds = created.rows.map((x: any) => x.id);
          if (!certIds.length) next = 'ISSUED';          // nobody qualified: nothing to deliver
          await audit(c, 'system', 'batch.certificates_created', { batchId: b.id }, { count: certIds.length });
        }
        await c.query('UPDATE batches SET status=$2, stage_entered_at=now(), escalated_at=NULL, updated_at=now() WHERE id=$1', [b.id, next]);
        await audit(c, 'system', 'batch.advanced', { batchId: b.id }, { from: b.status, to: next });
      }
    } else {
      next = body.decision === 'RETURN' ? 'RETURNED' : 'REJECTED';
      await c.query('UPDATE batches SET status=$2, return_reason=$3, updated_at=now() WHERE id=$1', [b.id, next, body.reason]);
      await audit(c, u.sub, body.decision === 'RETURN' ? 'batch.returned' : 'batch.rejected', { batchId: b.id }, { stage: b.status, reason: body.reason });
    }
    return { id: b.id, status: next, certIds };
  });
  // After commit: slow work goes to the queue. If Redis is down here, the sweeper re-queues from the DB.
  if (out.certIds.length) await enqueueIssue(out.certIds).catch(e => log.error({ err: e.message }, 'enqueue failed; sweeper will retry'));
  publish('batch.updated', { batchId: out.id });
  res.json({ status: out.status });
}));

// ---------- course rules (data, versioned, append-only) ----------
r.get('/courses/rules', auth(), wrap(async (_q, res) => {
  res.json((await pool.query('SELECT DISTINCT ON (lower(course)) * FROM course_rules ORDER BY lower(course), version DESC')).rows);
}));
r.post('/courses/rules', auth('STATE'), wrap(async (req, res) => {
  const b = z.object({ course: z.string().trim().min(2).max(80), minAttendance: z.number().min(0).max(100), minTheory: z.number().min(0).max(100), minPractical: z.number().min(0).max(100) }).parse(req.body);
  const row = await tx(async c => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [b.course.toLowerCase()]);   // two concurrent edits cannot take the same version
    const { rows: [x] } = await c.query(
      `INSERT INTO course_rules(course,version,min_attendance,min_theory,min_practical,created_by)
       VALUES($1,(SELECT coalesce(max(version),0)+1 FROM course_rules WHERE lower(course)=lower($1)),$2,$3,$4,$5) RETURNING *`,
      [b.course, b.minAttendance, b.minTheory, b.minPractical, req.user!.sub]);
    await audit(c, req.user!.sub, 'course_rule.created', {}, x);
    return x;
  });
  res.status(201).json(row);
}));

// Ineligible candidate gets a certificate ONLY with a recorded override + reason (state office, batch under review).
r.post('/candidates/:id/override', auth('STATE'), wrap(async (req, res) => {
  const { reason } = z.object({ reason: z.string().trim().min(3).max(500) }).parse(req.body);
  const k = await tx(async c => {
    const { rows: [x] } = await c.query(
      `UPDATE candidates ca SET override_reason=$2 FROM batches b
       WHERE ca.id=$1 AND b.id=ca.batch_id AND NOT ca.eligible AND ca.override_reason IS NULL
         AND b.status IN ('DISTRICT_REVIEW','QUALITY_REVIEW','STATE_REVIEW') RETURNING ca.batch_id`, [req.params.id, reason]);
    if (!x) throw new HttpError(409, 'Not an ineligible candidate in a batch under review');
    await audit(c, req.user!.sub, 'candidate.override', { batchId: x.batch_id }, { candidateId: req.params.id, reason });
    return x;
  });
  publish('batch.updated', { batchId: k.batch_id });
  res.json({ ok: true });
}));

// ---------- state office ----------
r.get('/stuck', auth('STATE'), wrap(async (_q, res) => {
  res.json((await pool.query(`SELECT id,title,status,stage_entered_at,escalated_at FROM batches WHERE escalated_at IS NOT NULL AND status IN ('DISTRICT_REVIEW','QUALITY_REVIEW','STATE_REVIEW') ORDER BY stage_entered_at`)).rows);
}));

r.post('/certificates/:id/cancel', auth('STATE'), wrap(async (req, res) => {
  const { reason } = z.object({ reason: z.string().trim().min(3).max(500) }).parse(req.body);
  const row = await tx(async c => {
    const { rows: [x] } = await c.query(
      `UPDATE certificates SET status='CANCELLED', cancel_reason=$2, cancelled_by=$3, cancelled_at=now() WHERE id=$1 AND status='VALID' RETURNING *`,
      [req.params.id, reason, req.user!.sub]);
    if (!x) throw new HttpError(409, 'Certificate not found or already cancelled');
    await audit(c, req.user!.sub, 'cert.cancelled', { batchId: x.batch_id, certId: x.id }, { serial: x.serial, reason });
    return x;
  });
  // Overwrite the cache with a cancellation tombstone so verification flips immediately.
  await redis.set(`verify:${row.token}`, JSON.stringify(view(row)), 'EX', 3600).catch(() => {});
  publish('cert.cancelled', { batchId: row.batch_id, certId: row.id });
  res.json({ ok: true });
}));

// Test/demo hook (off unless ENABLE_TEST_HOOKS=1): pretend a batch has waited 3 days, then run the SLA scan.
if (cfg.testHooks) r.post('/test/age/:id', auth('STATE'), wrap(async (req, res) => {
  await pool.query(`UPDATE batches SET stage_entered_at=now()-interval '3 days' WHERE id=$1`, [req.params.id]);
  res.json(await runScan());
}));

app.use('/api', r);
app.use((e: any, req: Request, res: Response, _n: NextFunction) => {
  if (e instanceof HttpError) return res.status(e.status).json({ error: e.message, ...e.extra });
  if (e instanceof z.ZodError) return res.status(400).json({ error: 'Invalid input', issues: e.issues });
  if (e.code === '23505') return res.status(409).json({ error: 'Conflict: a candidate already holds a valid certificate or the record already exists' });
  if (e.code === '22P02') return res.status(404).json({ error: 'Not found' });
  if (e.status && e.status < 500) return res.status(e.status).json({ error: 'Bad request' });
  (req as any).log.error(e);
  res.status(500).json({ error: 'Internal error' });
});