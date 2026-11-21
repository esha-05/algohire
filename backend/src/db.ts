import { Pool } from 'pg';
import { cfg } from './config';

export const pool = new Pool({ connectionString: cfg.pg, max: Number(process.env.PG_POOL || 10) });

export async function tx<T>(fn: (c: any) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
  catch (e) { await c.query('ROLLBACK'); throw e; }
  finally { c.release(); }
}

// Append-only audit trail; pass the transaction client so the record commits with the decision it describes.
export const audit = (c: any, actor: string, action: string, ref: { batchId?: string; certId?: string }, details: any = {}) =>
  c.query('INSERT INTO audit_log(actor,action,batch_id,cert_id,details) VALUES($1,$2,$3,$4,$5)',
    [actor, action, ref.batchId ?? null, ref.certId ?? null, JSON.stringify(details)]);
