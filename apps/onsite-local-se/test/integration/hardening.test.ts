import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { decryptField } from '../../src/crypto.js';
import { runMigrations } from '../../src/migrate.js';
import { CEMENT, HUB, startHarness, STORE_B, type Harness } from './harness.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

describe('Checkpoint 6: hardening', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.reset('S1');
  });

  describe('T17: repository scan', () => {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' });

    it('.env is ignored and not tracked', () => {
      expect(git('check-ignore', '.env').trim()).toBe('.env');
      expect(git('ls-files', '.env').trim()).toBe('');
    });

    it('no file that would be committed holds a secret', () => {
      const files = git('ls-files', '-co', '--exclude-standard', '-z')
        .split('\0')
        .filter(Boolean)
        .filter((file) => !file.endsWith('package-lock.json') && !file.startsWith('todo/'));
      expect(files.length).toBeGreaterThan(50);

      const patterns: [string, RegExp][] = [
        ['Anthropic key', /sk-ant-[a-zA-Z0-9_-]{20,}/],
        ['OpenAI-style key', /\bsk-[a-zA-Z0-9]{32,}\b/],
        ['Google key', /AIza[0-9A-Za-z_-]{30,}/],
        ['AWS key', /AKIA[0-9A-Z]{16}/],
        ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
        ['JWT', /eyJ[a-zA-Z0-9_-]{20,}\.eyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}/],
        ['password in a URL', /postgres:\/\/[^:\s]+:(?!REPLACE_ME|\$\{)[^@\s$]{4,}@/],
        ['assigned secret', /^(SE_JWT_SECRET|SE_DATA_KEY|SIMULATOR_SERVICE_TOKEN|DEMO_PASSWORD|SE_DB_PASSWORD|SIM_DB_PASSWORD|LLM_API_KEY|GEMINI_API_KEY|CENTRAL_DB_PASSWORD|SE_CENTRAL_TOKEN|CENTRAL_ADMIN_PASSWORD|SIM_DASHBOARD_PASSWORD)=(?!REPLACE_ME$|$).+/m],
      ];
      // The real values, when a local .env exists: none may appear anywhere.
      const envPath = path.join(repoRoot, '.env');
      const secretValues = readFileSync(envPath, 'utf8')
        .split(/\r?\n/)
        .filter((line) => /^(SE_JWT_SECRET|SE_DATA_KEY|SIMULATOR_SERVICE_TOKEN|DEMO_PASSWORD|SE_DB_PASSWORD|SIM_DB_PASSWORD|LLM_API_KEY|GEMINI_API_KEY|CENTRAL_DB_PASSWORD|SE_CENTRAL_TOKEN|CENTRAL_ADMIN_PASSWORD|SIM_DASHBOARD_PASSWORD)=.+/.test(line))
        .map((line) => line.slice(line.indexOf('=') + 1));

      const findings: string[] = [];
      for (const file of files) {
        const content = readFileSync(path.join(repoRoot, file), 'utf8');
        for (const [name, pattern] of patterns) {
          if (pattern.test(content)) findings.push(`${file}: ${name}`);
        }
        for (const value of secretValues) {
          if (content.includes(value)) findings.push(`${file}: a value from .env`);
        }
      }
      expect(findings).toEqual([]);
    });

    it('.env.example holds placeholders only', () => {
      const example = readFileSync(path.join(repoRoot, '.env.example'), 'utf8');
      expect(example).toMatch(/SE_JWT_SECRET=REPLACE_ME/);
      expect(example).toMatch(/LLM_API_KEY=\s*$/m);
    });

    it('Local SE has no way to reach the simulator database', () => {
      const compose = readFileSync(path.join(repoRoot, 'compose.yaml'), 'utf8');
      const local = compose.slice(compose.indexOf('onsite-local-se:'), compose.indexOf('volumes:', compose.indexOf('onsite-local-se:')));
      expect(local).not.toMatch(/SIM_DATABASE_URL|sim-db/);
      const sources = git('ls-files', '-co', '--exclude-standard', 'apps/onsite-local-se/src').split('\n').filter(Boolean);
      for (const file of sources) {
        expect(readFileSync(path.join(repoRoot, file), 'utf8'), file).not.toMatch(/SIM_DATABASE_URL/);
      }
    });
  });

  describe('API contract', () => {
    const required: [string, string][] = [
      ['post', '/api/v1/auth/login'],
      ['get', '/api/v1/health'],
      ['get', '/api/v1/stores'],
      ['get', '/api/v1/products'],
      ['get', '/api/v1/sites'],
      ['post', '/api/v1/orders'],
      ['get', '/api/v1/orders'],
      ['get', '/api/v1/orders/{id}'],
      ['post', '/api/v1/orders/{id}/cancel'],
      ['get', '/api/v1/orders/{id}/confirmation'],
      ['get', '/api/v1/staff/tasks'],
      ['get', '/api/v1/staff/tasks/{id}/picklist'],
      ['post', '/api/v1/staff/tasks/{id}/approve'],
      ['post', '/api/v1/staff/tasks/{id}/reject'],
      ['post', '/api/v1/staff/tasks/{id}/dispatch'],
      ['post', '/api/v1/staff/tasks/{id}/deliver'],
      ['get', '/api/v1/staff/normalization-reviews'],
      ['post', '/api/v1/staff/normalization-reviews/{id}/approve'],
      ['post', '/api/v1/staff/normalization-reviews/{id}/reject'],
      ['get', '/api/v1/stream'],
      ['get', '/api/v1/metrics'],
      ['post', '/api/v1/admin/connector/enable'],
      ['post', '/api/v1/admin/connector/disable'],
      ['get', '/api/v1/system/status'],
      ['get', '/api/v1/staff/normalization-reviews/stats'],
      ['post', '/api/v1/admin/demo/reset'],
    ];

    it('documents every endpoint of section 12.1 in Swagger, with schemas and security', async () => {
      const document = (await h.app.inject({ url: '/docs/json' })).json();
      for (const [method, url] of required) {
        const operation = document.paths[url]?.[method];
        expect(operation, `${method} ${url}`).toBeTruthy();
        expect(operation.summary, `${method} ${url}`).toBeTruthy();
        expect(operation.tags?.length, `${method} ${url}`).toBeGreaterThan(0);
        expect(Object.keys(operation.responses).length, `${method} ${url}`).toBeGreaterThan(0);
        const isPublic = url === '/api/v1/auth/login' || url === '/api/v1/health';
        if (!isPublic) expect(operation.security, `${method} ${url}`).toBeTruthy();
      }
      expect(document.paths['/api/v1/orders'].post.requestBody).toBeTruthy();
      expect(document.paths['/api/v1/staff/tasks/{id}/deliver'].post.requestBody).toBeTruthy();
    });

    it('has no undocumented /api route', async () => {
      const documented = Object.keys((await h.app.inject({ url: '/docs/json' })).json().paths).filter((url) => url.startsWith('/api'));
      expect(documented.sort()).toEqual([...new Set(required.map(([, url]) => url))].sort());
    });

    it('documents the simulator, including extend and outage', async () => {
      const paths = (await h.sim.inject({ url: '/docs/json' })).json().paths;
      for (const url of [
        '/legacy/stores',
        '/legacy/products',
        '/legacy/inventory',
        '/legacy/reservations',
        '/legacy/reservations/{id}',
        '/legacy/reservations/{id}/commit',
        '/legacy/reservations/{id}/extend',
        '/legacy/receipts',
        '/legacy/transactions',
        '/legacy/admin/outage',
      ]) {
        expect(paths[url], url).toBeTruthy();
      }
    });

    it('uses one error format everywhere', async () => {
      const token = await h.token('buyer.nordbygg');
      const cases = [
        await h.api('GET', '/api/v1/nope'),
        await h.api('GET', '/api/v1/stores'),
        await h.api('GET', '/api/v1/orders/SE-ORD-999999', { token }),
        await h.api('GET', '/api/v1/staff/tasks', { token }),
        await h.api('POST', '/api/v1/auth/login', { body: { username: 'x' } }),
        await h.api('POST', '/api/v1/auth/login', { body: { username: 'x', password: 'y' } }),
      ];
      expect(cases.map((c) => c.status)).toEqual([404, 401, 404, 403, 400, 401]);
      for (const response of cases) {
        expect(Object.keys(response.body)).toEqual(['error']);
        expect(Object.keys(response.body.error).sort()).toEqual(['code', 'message', 'request_id']);
        expect(response.body.error.request_id).toBe(response.headers['x-request-id']);
      }
    });

    it('a malformed task id or JSON body is a 400, not a 500', async () => {
      const staff = await h.token('staff.store-b');
      const badId = await h.api('POST', '/api/v1/staff/tasks/not-a-uuid/approve', { token: staff, body: { version: 1 } });
      expect(badId.status).toBe(400);
      const badJson = await h.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { 'content-type': 'application/json' },
        payload: '{not json',
      });
      expect(badJson.statusCode).toBe(400);
      expect(badJson.json().error.request_id).toBeTruthy();
    });

    it('hides internal details of an unexpected error', async () => {
      const service = h.app.container.catalog;
      const original = service.listStores;
      service.listStores = () => Promise.reject(new Error('secret connection string postgres://x'));
      const response = await h.api('GET', '/api/v1/stores', { token: await h.token('buyer.nordbygg') });
      service.listStores = original;
      expect(response.status).toBe(500);
      expect(response.body.error).toMatchObject({ code: 'INTERNAL_ERROR', message: 'Internal server error' });
      expect(JSON.stringify(response.body)).not.toContain('postgres');
    });
  });

  describe('audit', () => {
    it('records every state change with its actor and outcome, and no secrets', async () => {
      const order = await h.placeOrder(30);
      await h.act(order.body.order_id, STORE_B, 'approve');
      const { rows } = await h.pool.query('SELECT actor, action, resource, result, request_id FROM audit_logs ORDER BY audit_id');
      const actions = rows.map((row) => `${row.actor} ${row.action} ${row.result}`);
      expect(actions).toContain('buyer.nordbygg POST /api/v1/auth/login 200');
      expect(actions).toContain('buyer.nordbygg POST /api/v1/orders 201');
      expect(actions).toContain('staff.store-b POST /api/v1/staff/tasks/:id/approve 200');
      for (const row of rows) expect(row.request_id).toBeTruthy();
      const text = JSON.stringify(rows);
      expect(text).not.toContain(h.config.demoPassword);
      expect(text).not.toMatch(/eyJ[a-zA-Z0-9_-]{10,}\./);
    });

    it('records a failed login without the attempted name or password', async () => {
      await h.api('POST', '/api/v1/auth/login', { body: { username: 'someone@private.example', password: 'hunter2hunter2' } });
      const { rows } = await h.pool.query(`SELECT * FROM audit_logs WHERE result = '401'`);
      expect(rows[0]).toMatchObject({ actor: 'anonymous', action: 'POST /api/v1/auth/login' });
      expect(JSON.stringify(rows)).not.toMatch(/someone@private|hunter2/);
    });

    it('does not fill up with plain reads', async () => {
      await h.api('GET', '/api/v1/stores', { token: await h.token('buyer.nordbygg') });
      const { rows } = await h.pool.query(`SELECT 1 FROM audit_logs WHERE action LIKE 'GET %'`);
      expect(rows).toEqual([]);
    });
  });

  describe('encryption at rest', () => {
    it('stores ciphertext that decrypts with the SE key, bound to its row', async () => {
      const { rows } = await h.pool.query(`SELECT * FROM sites WHERE site_id = 'SE-SITE-001'`);
      const site = rows[0];
      const encrypted = { ciphertext: site.address_enc, nonce: site.address_nonce, tag: site.address_tag, keyId: site.key_id };
      const context = { country: 'SE', table: 'sites', rowId: site.site_id, field: 'address_enc' };
      expect(decryptField(encrypted, context, h.config.dataKey)).toContain('Askim');
      expect(() => decryptField(encrypted, { ...context, rowId: 'SE-SITE-002' }, h.config.dataKey)).toThrow();
      expect(() => decryptField(encrypted, context, Buffer.alloc(32, 7))).toThrow();
    });

    it('uses a fresh nonce for every field', async () => {
      const { rows } = await h.pool.query(`SELECT encode(address_nonce, 'hex') AS nonce FROM sites`);
      expect(new Set(rows.map((row) => row.nonce)).size).toBe(rows.length);
    });
  });

  describe('metrics and health', () => {
    it('reports all the required metrics, for admins only', async () => {
      await h.placeOrder(100);
      await h.reset('S2');
      await h.placeOrder(100);
      await h.api('GET', '/api/v1/stores', { token: await h.token('buyer.nordbygg') });
      expect((await h.api('GET', '/api/v1/metrics', { token: await h.token('buyer.nordbygg') })).status).toBe(403);
      const { body } = await h.api('GET', '/api/v1/metrics', { token: await h.token('admin.se') });
      expect(body.api.p50_ms).toBeGreaterThanOrEqual(0);
      expect(body.api.p95_ms).toBeGreaterThanOrEqual(body.api.p50_ms);
      expect(body.inventory.trusted).toBe(true);
      expect(body.inventory.last_successful_sync_at).toBeTruthy();
      expect(body.inventory.nodes).toHaveLength(11);
      expect(body.inventory.nodes[0]).toHaveProperty('inventory_freshness_s');
      expect(body.outbox.outbox_pending).toBeGreaterThan(0);
      expect(body.reservations).toHaveProperty('reservation_conflicts');
      expect(body.ai.ai_calls_total).toBe(3);
      expect(body.ai.normalization_records_total).toBeGreaterThan(0);
      expect(body.ai.review_queue_pending).toBe(3);
      expect(body.business).toMatchObject({ early_shortage_detected: 1, at_risk_count: 0, otif_rate: null, simulated_data: true });
    });

    it('stays up with the source down, and reports it', async () => {
      await h.outage(true);
      const response = await h.api('GET', '/api/v1/health');
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ status: 'degraded', db: 'ok', simulator: 'down', central: 'not_configured' });
    });

    it('reports Central as configured when it is', async () => {
      const { checkHealth } = await import('../../src/modules/metrics/health.service.js');
      const { simulator } = h.app.container;
      expect((await checkHealth(h.pool, simulator, 'http://central.example/ingest')).central).toBe('configured');
      expect((await checkHealth(h.pool, simulator)).central).toBe('not_configured');
    });
  });

  describe('seed and migrations', () => {
    it('is reproducible: the same scenario gives the same result', async () => {
      const snapshot = async () => {
        await h.reset('S1');
        const stock = await h.app.container.inventory.usableStock([CEMENT]);
        const order = await h.placeOrder(100);
        return {
          usable: stock.map((row) => [row.node_id, row.usable]),
          orderId: order.body.order_id,
          allocations: order.body.allocations,
          status: order.body.status,
          reviews: (await h.pool.query('SELECT field, raw_value, pending_record_count FROM normalization_review_queue ORDER BY raw_value')).rows,
          products: (await h.pool.query('SELECT sku_id, status FROM products ORDER BY sku_id')).rows,
        };
      };
      expect(await snapshot()).toEqual(await snapshot());
    });

    it('restarts the order numbering', async () => {
      expect((await h.placeOrder(1)).body.order_id).toBe('SE-ORD-000001');
      await h.reset('S1');
      expect((await h.placeOrder(1)).body.order_id).toBe('SE-ORD-000001');
    });

    it('switches scenarios', async () => {
      await h.reset('S2');
      expect((await h.placeOrder(100)).body.fulfillable_qty).toBe(90);
      await h.reset('S1');
      expect((await h.placeOrder(100)).body.allocations.map((a: { quantity: number }) => a.quantity)).toEqual([54, 46]);
    });

    it('applying migrations again changes nothing', async () => {
      expect(await runMigrations(h.pool)).toEqual([]);
    });

    it('has the required hub and stores', async () => {
      const { rows } = await h.pool.query('SELECT store_id FROM stores ORDER BY store_id');
      expect(rows.map((row) => row.store_id)).toContain(HUB);
      expect(rows).toHaveLength(11);
    });
  });
});
