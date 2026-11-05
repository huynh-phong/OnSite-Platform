import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createPool, type Db } from '../../src/db.js';
import { dropEverything, runMigrations } from '../../src/migrate.js';
import { ConnectionTracker } from '../../src/routes/gateway.js';
import { seedSimulator } from '../../src/services/seed.js';

const TOKEN = 'gateway-test-service-token-value';
const PASSWORD = 'gateway-test-password';
const auth = { authorization: `Bearer ${TOKEN}` };

function envValue(name: string): string {
  if (process.env[name]) return process.env[name]!;
  const file = readFileSync(new URL('../../../../.env', import.meta.url), 'utf8');
  const line = file.split(/\r?\n/).find((entry) => entry.startsWith(`${name}=`));
  if (!line) throw new Error(`${name} is not set`);
  return line.slice(name.length + 1);
}

async function testDatabaseUrl(): Promise<string> {
  const url = new URL(envValue('SIM_DATABASE_URL'));
  const testName = `${url.pathname.slice(1)}_test`;
  const admin = new pg.Client({ connectionString: url.toString() });
  await admin.connect();
  const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [testName]);
  if (!exists.rowCount) await admin.query(`CREATE DATABASE ${testName}`);
  await admin.end();
  url.pathname = `/${testName}`;
  return url.toString();
}

describe('Legacy dashboard gateway', () => {
  let pool: Db;
  let app: FastifyInstance;
  let cookie = '';
  const get = (url: string) => app.inject({ url, headers: { cookie } });
  const post = (url: string, payload?: object) =>
    app.inject({ method: 'POST', url, headers: { cookie }, ...(payload ? { payload } : {}) });

  beforeAll(async () => {
    process.env.LOG_LEVEL = 'silent';
    pool = createPool(await testDatabaseUrl());
    await dropEverything(pool);
    await runMigrations(pool);
    // No Local SE is running here, on purpose: the simulator must work without it.
    app = await buildApp(pool, { serviceToken: TOKEN, dashboardPassword: PASSWORD, localSeUrl: 'http://127.0.0.1:9' });
    const login = await app.inject({ method: 'POST', url: '/ui-api/login', payload: { password: PASSWORD } });
    cookie = String(login.headers['set-cookie']).split(';')[0]!;
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });
  beforeEach(async () => {
    await seedSimulator(pool, 'S1');
  });

  describe('authorization', () => {
    it.each([
      ['GET', '/ui-api/stores'],
      ['GET', '/ui-api/products'],
      ['GET', '/ui-api/inventory'],
      ['GET', '/ui-api/transactions'],
      ['GET', '/ui-api/connection'],
      ['GET', '/ui-api/outage'],
      ['POST', '/ui-api/outage'],
      ['POST', '/ui-api/receipts'],
      ['POST', '/ui-api/products'],
      ['POST', '/ui-api/demo/reset'],
      ['POST', '/ui-api/onsite/connector'],
    ] as const)('%s %s needs a session', async (method, url) => {
      expect((await app.inject({ method, url })).statusCode).toBe(401);
    });

    it('refuses a wrong password and a forged cookie', async () => {
      expect((await app.inject({ method: 'POST', url: '/ui-api/login', payload: { password: 'nope' } })).statusCode).toBe(401);
      expect((await app.inject({ url: '/ui-api/stores', headers: { cookie: 'sim_dashboard_session=9999999999.forged' } })).statusCode).toBe(401);
    });

    it('a service token is not a dashboard login, and a session cannot reach /legacy directly', async () => {
      expect((await app.inject({ url: '/ui-api/stores', headers: auth })).statusCode).toBe(401);
      expect((await app.inject({ url: '/legacy/stores', headers: { cookie } })).statusCode).toBe(401);
    });

    it('the x-sim-internal header cannot be guessed to skip the outage', async () => {
      await post('/ui-api/outage', { enabled: true });
      const response = await app.inject({ url: '/legacy/stores', headers: { ...auth, 'x-sim-internal': 'guess' } });
      expect(response.statusCode).toBe(503);
      await post('/ui-api/outage', { enabled: false });
    });
  });

  describe('service-token protection', () => {
    it('never returns the service token, in the body or the headers', async () => {
      for (const url of ['/ui-api/stores', '/ui-api/products', '/ui-api/inventory', '/ui-api/connection', '/ui-api/transactions']) {
        const response = await get(url);
        expect(response.statusCode, url).toBe(200);
        expect(response.body, url).not.toContain(TOKEN);
        expect(JSON.stringify(response.headers), url).not.toContain(TOKEN);
      }
      const login = await app.inject({ method: 'POST', url: '/ui-api/login', payload: { password: PASSWORD } });
      expect(JSON.stringify(login.headers) + login.body).not.toContain(TOKEN);
    });

    it('uses an HttpOnly, same-site session', async () => {
      const login = await app.inject({ method: 'POST', url: '/ui-api/login', payload: { password: PASSWORD } });
      expect(String(login.headers['set-cookie'])).toMatch(/HttpOnly; SameSite=Strict/);
    });
  });

  describe('data', () => {
    it('shows the 11 nodes, 21 products and all stock, with no OnSite running', async () => {
      expect((await get('/ui-api/stores')).json()).toHaveLength(11);
      expect((await get('/ui-api/products')).json().items).toHaveLength(21);
      expect((await get('/ui-api/inventory')).json().items).toHaveLength(231);
    });

    it('filters the ledger and validates the filter', async () => {
      const rows = (await get('/ui-api/transactions?node_id=SE-STORE-B&sku_id=SE-CEM-025')).json();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ type: 'INBOUND', qty: 60 });
      expect((await get("/ui-api/transactions?node_id=' OR 1=1")).statusCode).toBe(400);
    });

    it('receives stock and creates a product through the service API, with its validation', async () => {
      const receipt = await post('/ui-api/receipts', { node_id: 'SE-STORE-B', sku_id: 'SE-CEM-025', qty: 40 });
      expect(receipt.statusCode).toBe(201);
      expect(receipt.json().on_hand).toBe(100);
      expect((await post('/ui-api/receipts', { node_id: 'SE-STORE-B', sku_id: 'SE-CEM-025', qty: -1 })).statusCode).toBe(400);
      const product = await post('/ui-api/products', {
        sku_id: 'SE-UI-1',
        name: 'UI product',
        source_unit: 'knippe',
        source_category: 'cement',
        source_description: 'UI product 25kg',
        unit_price_sek: 10,
      });
      expect(product.statusCode).toBe(201);
      expect((await post('/ui-api/products', { sku_id: 'x' })).statusCode).toBe(400);
    });
  });

  describe('outage and recovery', () => {
    it('blocks the service API, keeps the dashboard readable, and recovers', async () => {
      expect((await post('/ui-api/outage', { enabled: true })).json()).toEqual({ enabled: true });
      expect((await get('/ui-api/outage')).json()).toEqual({ enabled: true });
      expect((await app.inject({ url: '/legacy/inventory', headers: auth })).statusCode).toBe(503);
      expect((await get('/ui-api/inventory')).statusCode).toBe(200);
      expect((await post('/ui-api/outage', { enabled: false })).json()).toEqual({ enabled: false });
      expect((await app.inject({ url: '/legacy/inventory', headers: auth })).statusCode).toBe(200);
    });
  });

  describe('connection state', () => {
    it('comes from real feed reads, and the dashboard\'s own reads do not count', async () => {
      // A fresh instance: earlier tests here have read the feed with the service token.
      const fresh = await buildApp(pool, { serviceToken: TOKEN, dashboardPassword: PASSWORD, localSeUrl: 'http://127.0.0.1:9' });
      const login = await fresh.inject({ method: 'POST', url: '/ui-api/login', payload: { password: PASSWORD } });
      const headers = { cookie: String(login.headers['set-cookie']).split(';')[0]! };
      const connection = async () => (await fresh.inject({ url: '/ui-api/connection', headers })).json();

      await fresh.inject({ url: '/ui-api/inventory', headers });
      const before = await connection();
      expect(before.state).toBe('DISCONNECTED');
      expect(before.onsite_process_reachable).toBe(false);

      await fresh.inject({ url: '/legacy/inventory?since_seq=0', headers: auth });
      expect((await connection()).state).toBe('CONNECTED');

      await fresh.inject({ method: 'POST', url: '/ui-api/outage', headers, payload: { enabled: true } });
      await fresh.inject({ url: '/legacy/inventory?since_seq=0', headers: auth });
      expect((await connection()).state).toBe('DEGRADED');
      await fresh.inject({ method: 'POST', url: '/ui-api/outage', headers, payload: { enabled: false } });
      await fresh.close();
    });

    it('moves through the states with time', () => {
      const tracker = new ConnectionTracker();
      const t = 1_000_000;
      expect(tracker.state(false, t)).toBe('DISCONNECTED');
      tracker.requestConnect(t);
      expect(tracker.state(false, t + 5000)).toBe('CONNECTING');
      expect(tracker.state(false, t + 31_000)).toBe('DISCONNECTED');
      tracker.notePoll(t);
      expect(tracker.state(false, t + 5000)).toBe('CONNECTED');
      expect(tracker.state(true, t + 5000)).toBe('DEGRADED');
      expect(tracker.state(false, t + 31_000)).toBe('DISCONNECTED');
    });

    it('reports plainly when OnSite is not running, and does not break', async () => {
      const response = await post('/ui-api/onsite/connector', { enabled: true, username: 'admin.se', password: 'x' });
      expect(response.statusCode).toBe(502);
      expect(response.json().error.code).toBe('ONSITE_UNREACHABLE');
      expect((await get('/ui-api/stores')).statusCode).toBe(200);
    });
  });

  describe('demo reset', () => {
    it('needs the typed confirmation, and then applies the scenario', async () => {
      await post('/ui-api/receipts', { node_id: 'SE-STORE-B', sku_id: 'SE-CEM-025', qty: 40 });
      expect((await post('/ui-api/demo/reset', { scenario: 'S2', confirm: 'yes' })).statusCode).toBe(400);
      expect((await post('/ui-api/demo/reset', { scenario: 'S9', confirm: 'RESET' })).statusCode).toBe(400);
      const stock = await get('/ui-api/inventory');
      const hub = () => stock.json().items.find((row: { node_id: string; sku_id: string }) => row.node_id === 'SE-HUB-01' && row.sku_id === 'SE-CEM-025');
      expect(hub().on_hand).toBe(60);
      expect((await post('/ui-api/demo/reset', { scenario: 'S2', confirm: 'RESET' })).statusCode).toBe(200);
      const after = (await get('/ui-api/inventory')).json().items.find((row: { node_id: string; sku_id: string }) => row.node_id === 'SE-HUB-01' && row.sku_id === 'SE-CEM-025');
      expect(after.on_hand).toBe(40);
    });

    it('also needs the confirmation on the service API', async () => {
      const refused = await app.inject({ method: 'POST', url: '/legacy/admin/reset', headers: auth, payload: { scenario: 'S1', confirm: 'no' } });
      expect(refused.statusCode).toBe(400);
      expect((await app.inject({ method: 'POST', url: '/legacy/admin/reset', payload: { scenario: 'S1', confirm: 'RESET' } })).statusCode).toBe(401);
    });
  });
});
