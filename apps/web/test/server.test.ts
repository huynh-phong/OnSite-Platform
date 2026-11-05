// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildWebServer } from '../server/app';

describe('web server and API proxy', () => {
  let upstream: Server;
  let app: FastifyInstance;
  let base: string;
  let dir: string;
  let last: { url?: string; method?: string; headers: IncomingHttpHeaders; body: string } = { headers: {}, body: '' };

  beforeAll(async () => {
    process.env.LOG_LEVEL = 'silent';
    dir = mkdtempSync(path.join(tmpdir(), 'onsite-web-'));
    mkdirSync(path.join(dir, 'assets'));
    writeFileSync(path.join(dir, 'web.html'), '<html>app</html>');
    writeFileSync(path.join(dir, 'assets', 'a.js'), 'console.log(1)');
    upstream = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        last = { url: request.url, method: request.method, headers: request.headers, body: Buffer.concat(chunks).toString() };
        if (request.url === '/api/v1/stream') {
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.write('event: task.assigned\ndata: {"a":1}\n\n');
          return; // Left open, like a real stream.
        }
        response.statusCode = request.url === '/api/v1/forbidden' ? 403 : 200;
        response.setHeader('content-type', 'application/json');
        response.setHeader('x-request-id', 'upstream-id');
        response.setHeader('set-cookie', 'a=b');
        response.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    app = await buildWebServer({ localSeUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, staticDir: dir });
    base = await app.listen({ host: '127.0.0.1', port: 0 });
  });
  afterAll(async () => {
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('forwards method, body and the headers the API needs, and passes the answer back', async () => {
    const response = await fetch(`${base}/api/v1/orders?x=1`, {
      method: 'POST',
      headers: { authorization: 'Bearer t', 'idempotency-key': 'k', 'content-type': 'application/json', cookie: 'secret=1' },
      body: '{"a":1}',
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-request-id')).toBe('upstream-id');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(last).toMatchObject({ url: '/api/v1/orders?x=1', method: 'POST', body: '{"a":1}' });
    expect(last.headers).toMatchObject({ authorization: 'Bearer t', 'idempotency-key': 'k' });
    expect(last.headers.cookie).toBeUndefined();
  });

  it('passes authorization errors through unchanged', async () => {
    expect((await fetch(`${base}/api/v1/forbidden`)).status).toBe(403);
  });

  it('streams SSE without waiting for it to end', async () => {
    const controller = new AbortController();
    const response = await fetch(`${base}/api/v1/stream`, { headers: { authorization: 'Bearer t' }, signal: controller.signal });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const { value } = await response.body!.getReader().read();
    expect(new TextDecoder().decode(value)).toContain('task.assigned');
    controller.abort();
  });

  it('refuses a token in a URL', async () => {
    const response = await fetch(`${base}/api/v1/stream?token=abc`);
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('TOKEN_IN_URL');
  });

  it('serves the app for client routes, and static assets', async () => {
    const page = await fetch(`${base}/customer/orders/SE-ORD-000001`);
    expect(await page.text()).toBe('<html>app</html>');
    expect(page.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(page.headers.get('x-frame-options')).toBe('DENY');
    const asset = await fetch(`${base}/assets/a.js`);
    expect(await asset.text()).toBe('console.log(1)');
    expect((await fetch(`${base}/assets/missing.js`)).status).toBe(404);
  });

  it('does not serve files outside the build', async () => {
    const response = await fetch(`${base}/assets/%2e%2e%2f%2e%2e%2fsecret.txt`);
    expect(response.status).toBe(404);
  });

  it('reports a clear error when Local SE is down', async () => {
    const down = await buildWebServer({ localSeUrl: 'http://127.0.0.1:9', staticDir: dir });
    const response = await down.inject({ url: '/api/v1/orders' });
    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe('LOCAL_SE_UNAVAILABLE');
    await down.close();
  });
});
