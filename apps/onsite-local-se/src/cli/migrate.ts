import { createPool } from '../db.js';
import { runMigrations } from '../migrate.js';

const pool = createPool(process.env.SE_DATABASE_URL ?? '');
try {
  console.log('se-db migrations applied:', await runMigrations(pool));
} finally {
  await pool.end();
}
