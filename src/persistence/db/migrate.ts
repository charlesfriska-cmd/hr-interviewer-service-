/**
 * Forward-only migration runner. No framework: the MVP has no down-migration
 * requirement, and rollback is a prior image plus a compensating file.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type pg from 'pg';

export async function migrate(pool: pg.Pool, dir: string): Promise<string[]> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  );
  const { rows } = await pool.query<{ version: string }>('SELECT version FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.version));

  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const ran: string[] = [];
  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    if (applied.has(version)) continue;
    const sql = await readFile(path.join(dir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      // The file inserts its own row; this covers files that do not.
      await client.query(
        'INSERT INTO schema_migrations(version) VALUES ($1) ON CONFLICT DO NOTHING',
        [version],
      );
      await client.query('COMMIT');
      ran.push(version);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
  return ran;
}
