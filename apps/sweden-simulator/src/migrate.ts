import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './db.js';
import { withTransaction } from './db.js';

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
const MIGRATION_LOCK_ID = 727001;

/** Applies pending .sql files in name order, each in its own transaction. Returns the names applied. */
export async function runMigrations(pool: Db): Promise<string[]> {
  const lockClient = await pool.connect();
  try {
    await lockClient.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    await lockClient.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const done = await lockClient.query<{ name: string }>('SELECT name FROM schema_migrations');
    const applied = new Set(done.rows.map((row) => row.name));

    const files = (await readdir(migrationsDir)).filter((file) => file.endsWith('.sql')).sort();
    const newlyApplied: string[] = [];
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(path.join(migrationsDir, file), 'utf8');
      await withTransaction(pool, async (client) => {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      });
      newlyApplied.push(file);
    }
    return newlyApplied;
  } finally {
    await lockClient.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
    lockClient.release();
  }
}

export async function dropEverything(pool: Db): Promise<void> {
  await pool.query('DROP SCHEMA public CASCADE');
  await pool.query('CREATE SCHEMA public');
}
