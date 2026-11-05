import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { runMigrations } from './migrate.js';
import { startWorkers } from './workers.js';

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const applied = await runMigrations(pool);
const app = await buildApp(config, pool);
app.log.info({ applied }, 'migrations complete');

const stopWorkers = startWorkers(app.container, app.log);

async function shutdown(): Promise<void> {
  await stopWorkers();
  await app.close();
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ host: '0.0.0.0', port: config.port });
