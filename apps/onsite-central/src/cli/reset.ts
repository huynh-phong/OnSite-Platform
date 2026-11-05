import { createPool } from '../db.js';
import { dropEverything, runMigrations } from '../migrate.js';

const pool = createPool(process.env.CENTRAL_DATABASE_URL ?? '');
try {
  await dropEverything(pool);
  console.log('central-db migrations applied:', await runMigrations(pool));
} finally {
  await pool.end();
}
