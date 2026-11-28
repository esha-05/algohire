import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { cfg } from './config';
import { parseCsv, Row } from './csv';

export type User = { sub: string; name: string; role: 'CENTRE' | 'DISTRICT' | 'QUALITY' | 'STATE'; district?: string; centre?: string };
declare global { namespace Express { interface Request { user?: User } } }

export class HttpError extends Error { constructor(public status: number, msg: string, public extra: any = {}) { super(msg); } }
export const wrap = (fn: (req: Request, res: Response) => Promise<any>) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

export const signToken = (u: User) => jwt.sign(u, cfg.jwt, { algorithm: 'HS256', expiresIn: '12h' });
export const verifyToken = (t: string) => jwt.verify(t, cfg.jwt, { algorithms: ['HS256'] }) as User;

// Identity ALWAYS comes from the signed token, never from request bodies.
export const auth = (...roles: string[]) => (req: Request, _res: Response, next: NextFunction) => {
  const h = req.headers.authorization || '';
  try { req.user = verifyToken(h.startsWith('Bearer ') ? h.slice(7) : ''); } catch { return next(new HttpError(401, 'Unauthenticated')); }
  if (roles.length && !roles.includes(req.user!.role)) return next(new HttpError(403, 'This action is not available for your role'));
  next();
};

// Review stages: which role acts, how many distinct approvals are needed.
export const STAGES: Record<string, { role: string; need: number }> = {
  DISTRICT_REVIEW: { role: 'DISTRICT', need: 2 },
  QUALITY_REVIEW: { role: 'QUALITY', need: 1 },
  STATE_REVIEW: { role: 'STATE', need: 1 },
};

// Loads a batch only if this user may see it (404 otherwise, so existence is not leaked).
export async function getBatch(c: any, id: string, u: User, lock = false) {
  const { rows: [b] } = await c.query(
    `SELECT b.*, ce.district, ce.name AS centre_name FROM batches b JOIN centres ce ON ce.id=b.centre_id WHERE b.id=$1 ${lock ? 'FOR UPDATE OF b' : ''}`, [id]);
  const ok = b && (u.role === 'CENTRE' ? b.centre_id === u.centre : b.status !== 'DRAFT' && (u.role !== 'DISTRICT' || b.district === u.district));
  if (!ok) throw new HttpError(404, 'Batch not found');
  return b;
}

function evaluate(r: Row, rule: any) {
  const reasons: string[] = [];
  if (r.attendance < +rule.min_attendance) reasons.push(`attendance ${r.attendance} < ${+rule.min_attendance}`);
  if (r.theory < +rule.min_theory) reasons.push(`theory ${r.theory} < ${+rule.min_theory}`);
  if (r.practical < +rule.min_practical) reasons.push(`practical ${r.practical} < ${+rule.min_practical}`);
  return { ...r, eligible: !reasons.length, reasons };
}

// Whole sheet is validated; then every candidate is judged against the LATEST rule version for the course.
export async function validateCsv(c: any, course: string, text: string) {
  const { rows, errors } = parseCsv(text);
  const { rows: [rule] } = await c.query('SELECT * FROM course_rules WHERE lower(course)=lower($1) ORDER BY version DESC LIMIT 1', [course]);
  if (!rule) throw new HttpError(422, `No qualifying rule is set for "${course}". The state office must create one first.`);
  if (!errors.length) {
    const { rows: held } = await c.query(`SELECT phone FROM certificates WHERE course=$1 AND status='VALID' AND phone=ANY($2)`, [course, rows.map(r => r.phone)]);
    const set = new Set(held.map((h: any) => h.phone));
    rows.forEach((r, i) => set.has(r.phone) && errors.push({ row: i + 2, message: `${r.phone} already holds a valid ${course} certificate` }));
  }
  if (errors.length) throw new HttpError(422, 'Spreadsheet has errors; nothing was saved', { errors: errors.slice(0, 100) });
  return { rows: rows.map(r => evaluate(r, rule)), rule };
}

export async function saveCandidates(c: any, batchId: string, rows: any[], ruleId: number) {
  await c.query('DELETE FROM candidates WHERE batch_id=$1', [batchId]);
  await c.query(
    `INSERT INTO candidates(batch_id,name,phone,attendance,theory,practical,eligible,reasons)
     SELECT $1::uuid,n,p,a,t,pr,e,coalesce(string_to_array(nullif(rs,''),'|'),'{}')
     FROM unnest($2::text[],$3::text[],$4::numeric[],$5::numeric[],$6::numeric[],$7::boolean[],$8::text[]) AS x(n,p,a,t,pr,e,rs)`,
    [batchId, rows.map(r => r.name), rows.map(r => r.phone), rows.map(r => r.attendance), rows.map(r => r.theory), rows.map(r => r.practical), rows.map(r => r.eligible), rows.map(r => r.reasons.join('|'))]);
  await c.query('UPDATE batches SET size=$2, rule_id=$3, updated_at=now() WHERE id=$1', [batchId, rows.length, ruleId]);
}
