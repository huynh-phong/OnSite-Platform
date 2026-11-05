import { createPool } from '../db.js';
import { dropEverything, runMigrations } from '../migrate.js';
import { seedSimulator } from '../services/seed.js';

const pool = createPool(process.env.SIM_DATABASE_URL ?? '');
try {
  await dropEverything(pool);
  console.log('sim-db migrations applied:', await runMigrations(pool));
  console.log('sim-db seeded:', await seedSimulator(pool, process.argv[2] ?? 'S1'));
} finally {
  await pool.end();
}
