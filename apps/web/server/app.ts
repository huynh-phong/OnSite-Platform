import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import Fastify, { type FastifyInstance } from 'fastify';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.map': 'application/json',
};

/** Only what the API needs crosses the proxy. Cookies, for one, do not. */
const FORWARDED_REQUEST_HEADERS = ['authorization', 'content-type', 'idempotency-key', 'accept'];
const FORWARDED_RESPONSE_HEADERS = ['content-type', 'x-request-id', 'cache-control'];

export interface WebServerOptions {
  localSeUrl: string;
  staticDir: string;
  timeoutMs?: number;
}

/**
 * Serves the web app and passes /api through to Local SE, so that the browser only ever talks to one origin
 * and no CORS opening is needed. It holds no secrets and makes no decisions: Local SE authorizes every call.
 * Streams pass straight through, which is what SSE needs.
 */
export async function buildWebServer(options: WebServerOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      serializers: { req: (request) => ({ method: request.method, url: request.url.split('?')[0] }) },
    },
    genReqId: () => randomUUID(),
    requestIdLogLabel: 'request_id',
    bodyLimit: 1_000_000,
  });

  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));

  app.addHook('onSend', async (_request, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'same-origin');
    reply.header('content-security-policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'");
  });

  app.get('/health', async () => ({ status: 'ok' }));

  app.route({
    method: ['GET', 'POST', 'DELETE'],
    url: '/api/*',
    handler: async (request, reply) => {
      const upstreamUrl = new URL(request.url, options.localSeUrl);
      // The app never puts a token in a URL. Refusing it here keeps one from reaching any log or history.
      if (upstreamUrl.searchParams.has('token')) {
        return reply.code(400).send({
          error: { code: 'TOKEN_IN_URL', message: 'Send the token in the Authorization header', request_id: request.id },
        });
      }
      const headers: Record<string, string> = {};
      for (const name of FORWARDED_REQUEST_HEADERS) {
        const value = request.headers[name];
        if (typeof value === 'string') headers[name] = value;
      }
      const isStream = upstreamUrl.pathname === '/api/v1/stream';
      const abort = new AbortController();
      const timer = isStream ? undefined : setTimeout(() => abort.abort(), options.timeoutMs ?? 60_000);
      // Stop reading from upstream once the browser has gone away, so that streams do not pile up.
      reply.raw.on('close', () => abort.abort());
      try {
        const upstream = await fetch(upstreamUrl, {
          method: request.method,
          headers,
          ...(Buffer.isBuffer(request.body) ? { body: new Uint8Array(request.body) } : {}),
          signal: abort.signal,
        });
        for (const name of FORWARDED_RESPONSE_HEADERS) {
          const value = upstream.headers.get(name);
          if (value) reply.header(name, value);
        }
        reply.code(upstream.status);
        if (!upstream.body) return reply.send();
        const body = Readable.fromWeb(upstream.body as NodeReadableStream);
        body.on('error', () => undefined);
        return reply.send(body);
      } catch {
        return reply.code(502).send({
          error: { code: 'LOCAL_SE_UNAVAILABLE', message: 'OnSite Local SE cannot be reached right now', request_id: request.id },
        });
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  });

  const root = path.resolve(options.staticDir);
  const index = path.join(root, 'web.html');
  app.setNotFoundHandler((request, reply) => {
    if (request.method !== 'GET' || request.url.startsWith('/api/')) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found', request_id: request.id } });
    }
    const pathname = decodeURIComponent(request.url.split('?')[0]!);
    const file = path.resolve(root, `.${pathname}`);
    if (pathname.startsWith('/assets/')) {
      if (file.startsWith(path.join(root, 'assets') + path.sep) && existsSync(file) && statSync(file).isFile()) {
        return reply
          .type(TYPES[path.extname(file)] ?? 'application/octet-stream')
          .header('cache-control', 'public, max-age=31536000, immutable')
          .send(readFileSync(file));
      }
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'File not found', request_id: request.id } });
    }
    if (!existsSync(index)) {
      return reply.code(503).type('text/plain').send('The web app has not been built. Run: npm run build');
    }
    // Client-side routes.
    return reply.type(TYPES['.html']!).send(readFileSync(index));
  });

  return app;
}
