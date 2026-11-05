import { loadConfig } from '../config.js';
import { createPool } from '../db.js';
import { seedLocal } from '../seed.js';

const config = loadConfig();
const pool = createPool(config.databaseUrl);
try {
  console.log('se-db seeded:', await seedLocal(pool, config));
} finally {
  await pool.end();
}
