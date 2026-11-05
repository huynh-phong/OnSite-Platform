import { createPool } from '../db.js';
import { runMigrations } from '../migrate.js';

const pool = createPool(process.env.SIM_DATABASE_URL ?? '');
try {
  console.log('sim-db migrations applied:', await runMigrations(pool));
} finally {
  await pool.end();
}
