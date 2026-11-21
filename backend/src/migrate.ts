import fs from 'fs';
import path from 'path';
import { pool } from './db';

(async () => {
  const c = await pool.connect();
  await c.query('SELECT pg_advisory_lock(424242)');            // safe if several instances start together
  await c.query('CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY)');
  const dir = path.join(__dirname, '../migrations');
  for (const f of fs.readdirSync(dir).sort()) {
    if ((await c.query('SELECT 1 FROM schema_migrations WHERE name=$1', [f])).rowCount) continue;
    await c.query('BEGIN');
    await c.query(fs.readFileSync(path.join(dir, f), 'utf8'));
    await c.query('INSERT INTO schema_migrations VALUES($1)', [f]);
    await c.query('COMMIT');
    console.log('applied', f);
  }
  await c.query('SELECT pg_advisory_unlock(424242)');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
