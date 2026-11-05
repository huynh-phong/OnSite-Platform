import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
};

/** Serves a built single-page app. Does nothing if it has not been built, so the API works on its own. */
export function registerStaticUi(app: FastifyInstance, dir: string, html: string): void {
  const index = path.join(dir, html);
  if (!existsSync(index)) return;
  const root = path.resolve(dir);
  const sendIndex = () => readFileSync(index);

  app.get('/', { schema: { hide: true } }, async (_request, reply) => reply.type(TYPES['.html']!).send(sendIndex()));
  app.get('/assets/*', { schema: { hide: true } }, async (request, reply) => {
    const relative = (request.params as { '*': string })['*'];
    const file = path.resolve(root, 'assets', relative);
    if (!file.startsWith(path.join(root, 'assets') + path.sep) || !existsSync(file) || !statSync(file).isFile()) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'File not found', request_id: request.id } });
    }
    return reply
      .type(TYPES[path.extname(file)] ?? 'application/octet-stream')
      .header('cache-control', 'public, max-age=31536000, immutable')
      .send(readFileSync(file));
  });
}
