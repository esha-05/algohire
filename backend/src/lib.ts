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

export async function validateCsv(c: any, course: string, text: string): Promise<Row[]> {
  const { rows, errors } = parseCsv(text);
  if (!errors.length) {
    const { rows: held } = await c.query(`SELECT phone FROM certificates WHERE course=$1 AND status='VALID' AND phone=ANY($2)`, [course, rows.map(r => r.phone)]);
    const set = new Set(held.map((h: any) => h.phone));
    rows.forEach((r, i) => set.has(r.phone) && errors.push({ row: i + 2, message: `${r.phone} already holds a valid ${course} certificate` }));
  }
  if (errors.length) throw new HttpError(422, 'Spreadsheet has errors; nothing was saved', { errors: errors.slice(0, 100) });
  return rows;
}

export async function saveCandidates(c: any, batchId: string, rows: Row[]) {
  await c.query('DELETE FROM candidates WHERE batch_id=$1', [batchId]);
  await c.query('INSERT INTO candidates(batch_id,name,phone) SELECT $1::uuid,n,p FROM unnest($2::text[],$3::text[]) AS t(n,p)',
    [batchId, rows.map(r => r.name), rows.map(r => r.phone)]);
  await c.query('UPDATE batches SET size=$2, updated_at=now() WHERE id=$1', [batchId, rows.length]);
}
