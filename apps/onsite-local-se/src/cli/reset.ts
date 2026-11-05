import { loadConfig } from '../config.js';
import { createPool } from '../db.js';
import { dropEverything, runMigrations } from '../migrate.js';
import { seedLocal } from '../seed.js';

const config = loadConfig();
const pool = createPool(config.databaseUrl);
try {
  await dropEverything(pool);
  console.log('se-db migrations applied:', await runMigrations(pool));
  console.log('se-db seeded:', await seedLocal(pool, config));
} finally {
  await pool.end();
}
