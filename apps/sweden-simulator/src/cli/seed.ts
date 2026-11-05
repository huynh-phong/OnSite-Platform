import { createPool } from '../db.js';
import { seedSimulator } from '../services/seed.js';

const pool = createPool(process.env.SIM_DATABASE_URL ?? '');
try {
  console.log('sim-db seeded:', await seedSimulator(pool, process.argv[2] ?? 'S1'));
} finally {
  await pool.end();
}
