import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { runMigrations } from './migrate.js';
import { sweepExpiredReservations } from './services/reservations.js';

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const applied = await runMigrations(pool);
const app = await buildApp(pool, {
  serviceToken: config.serviceToken,
  dashboardPassword: config.dashboardPassword,
  localSeUrl: config.localSeUrl,
});
app.log.info({ applied }, 'migrations complete');

// Keeps running during a simulated outage: the outage only affects the API.
const sweep = setInterval(() => {
  sweepExpiredReservations(pool).catch((error: unknown) => app.log.error({ err: error }, 'expiry sweep failed'));
}, config.expirySweepSeconds * 1000);

async function shutdown(): Promise<void> {
  clearInterval(sweep);
  await app.close();
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ host: '0.0.0.0', port: config.port });
