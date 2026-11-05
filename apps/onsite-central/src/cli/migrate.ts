import { createPool } from '../db.js';
import { runMigrations } from '../migrate.js';

const pool = createPool(process.env.CENTRAL_DATABASE_URL ?? '');
try {
  console.log('central-db migrations applied:', await runMigrations(pool));
} finally {
  await pool.end();
}
