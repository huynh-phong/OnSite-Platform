import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWebServer } from './app.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = await buildWebServer({
  localSeUrl: (process.env.LOCAL_SE_URL ?? 'http://localhost:4000').replace(/\/$/, ''),
  staticDir: process.env.WEB_STATIC_DIR ?? path.resolve(here, '../dist/web'),
});

async function shutdown(): Promise<void> {
  await app.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? 3000) });
