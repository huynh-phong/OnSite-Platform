import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp as buildCentral } from '../../../onsite-central/src/app.js';
import { createPool as createCentralPool } from '../../../onsite-central/src/db.js';
import { dropEverything, runMigrations } from '../../../onsite-central/src/migrate.js';
import { resetCentral } from '../../../onsite-central/src/services/ingest.js';
import { HUB, startHarness, STORE_B, type Harness } from './harness.js';

const TOKEN = 'central-integration-token';
const PASSWORD = 'central-integration-password';

function envValue(name: string): string {
  if (process.env[name]) return process.env[name]!;
  const file = readFileSync(new URL('../../../../.env', import.meta.url), 'utf8');
  const line = file.split(/\r?\n/).find((entry) => entry.startsWith(`${name}=`));
  if (!line) throw new Error(`${name} is not set`);
  return line.slice(name.length + 1);
}

async function testDatabaseUrl(): Promise<string> {
  const url = new URL(envValue('CENTRAL_DATABASE_URL'));
  const testName = `${url.pathname.slice(1)}_it`;
  const admin = new pg.Client({ connectionString: url.toString() });
  await admin.connect();
  const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [testName]);
  if (!exists.rowCount) await admin.query(`CREATE DATABASE ${testName}`);
  await admin.end();
  url.pathname = `/${testName}`;
  return url.toString();
}

describe('Local SE and Central over real HTTP', () => {
  let h: Harness;
  let central: FastifyInstance;
  let centralPool: ReturnType<typeof createCentralPool>;
  let ingestUrl: string;
  let cookie = '';

  const drain = async () => {
    await h.pool.query(`UPDATE outbox_events SET next_attempt_at = now() WHERE status = 'PENDING'`);
    for (let i = 0; i < 20; i += 1) {
      if ((await h.app.container.outbox.tick()) === 0) return;
    }
  };
  const offline = (enabled: boolean) =>
    central.inject({ method: 'POST', url: '/admin/offline', headers: { cookie }, payload: { enabled } });
  const dashboard = async () => (await central.inject({ url: '/dashboard', headers: { cookie } })).json();
  const outboxCounts = async () =>
    (await h.pool.query('SELECT status, count(*)::int AS n FROM outbox_events GROUP BY status')).rows.reduce(
      (all, row) => ({ ...all, [row.status]: row.n }),
      {} as Record<string, number>,
    );
  const projection = async (orderId: string) =>
    (await centralPool.query('SELECT status, version FROM order_projection WHERE order_id = $1', [orderId])).rows[0];
  const localVersion = async (orderId: string) =>
    (await h.pool.query('SELECT status, version FROM orders WHERE order_id = $1', [orderId])).rows[0];

  beforeAll(async () => {
    h = await startHarness();
    centralPool = createCentralPool(await testDatabaseUrl());
    await dropEverything(centralPool);
    await runMigrations(centralPool);
    central = await buildCentral({ port: 0, databaseUrl: '', ingestToken: TOKEN, adminPassword: PASSWORD }, centralPool);
    await central.listen({ host: '127.0.0.1', port: 0 });
    ingestUrl = `http://127.0.0.1:${(central.server.address() as AddressInfo).port}/ingest/events`;
    const login = await central.inject({ method: 'POST', url: '/auth/login', payload: { password: PASSWORD } });
    cookie = String(login.headers['set-cookie']).split(';')[0]!;
  });
  afterAll(async () => {
    await central.close();
    await centralPool.end();
    await h.close();
  });
  beforeEach(async () => {
    await h.reset('S1');
    await resetCentral(centralPool);
    h.config.centralIngestUrl = ingestUrl;
    h.config.centralServiceToken = TOKEN;
  });

  it('projects a whole order flow to the same final state as Local', async () => {
    const order = await h.placeOrder(100);
    const orderId = order.body.order_id;
    await h.act(orderId, STORE_B, 'approve');
    await h.act(orderId, HUB, 'approve');
    await drain();
    expect((await projection(orderId)).status).toBe('APPROVED');

    await h.act(orderId, STORE_B, 'dispatch');
    await h.act(orderId, HUB, 'dispatch');
    await h.act(orderId, STORE_B, 'deliver', { delivered_qty: 54 });
    await h.act(orderId, HUB, 'deliver', { delivered_qty: 46 });
    await drain();

    expect(await projection(orderId)).toEqual(await localVersion(orderId));
    const { kpis, central_sync_lag_ms: lag } = await dashboard();
    expect(kpis).toMatchObject({ total_orders: 1, delivered_orders: 1, simulated_otif_rate: 1 });
    expect(lag.sampled_events).toBeGreaterThan(5);
    expect(lag.latest).toBeGreaterThanOrEqual(0);
    expect(await outboxCounts()).toEqual({ DELIVERED: expect.any(Number) });
  });

  it('counts an S2 shortage as an early detection', async () => {
    await h.reset('S2');
    h.config.centralIngestUrl = ingestUrl;
    h.config.centralServiceToken = TOKEN;
    await h.placeOrder(100);
    await drain();
    expect((await dashboard()).kpis.early_shortage_detected).toBe(1);
  });

  it('Central offline: Local completes the order, events wait, and recovery catches up without double counting', async () => {
    const first = await h.placeOrder(10);
    await drain();
    const before = (await dashboard()).kpis.total_orders;
    expect(before).toBe(1);

    await offline(true);
    const second = await h.placeOrder(10);
    expect(second.body.status).toBe('AWAITING_APPROVAL');
    expect((await h.act(second.body.order_id, STORE_B, 'approve')).body.order_status).toBe('APPROVED');
    await h.act(second.body.order_id, STORE_B, 'dispatch');
    await h.act(second.body.order_id, STORE_B, 'deliver', { delivered_qty: 10 });
    await drain();

    // Local finished the whole order, and every event from it is still waiting.
    expect((await localVersion(second.body.order_id)).status).toBe('DELIVERED');
    const pending = (await outboxCounts()).PENDING;
    expect(pending).toBeGreaterThan(5);
    expect((await dashboard()).kpis.total_orders).toBe(1);
    const metrics = await h.api('GET', '/api/v1/metrics', { token: await h.token('admin.se') });
    expect(metrics.body.outbox.outbox_pending).toBe(pending);
    // A 503 is not a refusal, so nothing heads toward DEAD.
    const refused = await h.pool.query('SELECT max(non_retryable_failures) AS n FROM outbox_events');
    expect(Number(refused.rows[0].n)).toBe(0);

    await offline(false);
    await drain();
    expect((await outboxCounts()).PENDING).toBeUndefined();
    expect(await projection(second.body.order_id)).toEqual(await localVersion(second.body.order_id));
    expect(await projection(first.body.order_id)).toEqual(await localVersion(first.body.order_id));
    const after = await dashboard();
    expect(after.kpis).toMatchObject({ total_orders: 2, delivered_orders: 1 });
    expect(after.countries[0].duplicate_events_ignored).toBe(0);
  });

  it('a redelivered event after a lost acknowledgement is ignored', async () => {
    await h.placeOrder(5);
    await drain();
    const received = (await dashboard()).countries[0].events_received;
    // As if every acknowledgement had been lost: Local sends them all again.
    await h.pool.query(`UPDATE outbox_events SET status = 'PENDING', next_attempt_at = now(), delivered_at = NULL`);
    await drain();
    const after = (await dashboard()).countries[0];
    expect(after.events_received).toBe(received);
    expect(after.duplicate_events_ignored).toBe(received);
    expect((await dashboard()).kpis.total_orders).toBe(1);
  });

  it('a wrong token does not lose events: they are refused and stay retryable up to the limit', async () => {
    h.config.centralServiceToken = 'wrong';
    await h.placeOrder(1);
    await drain();
    const counts = await outboxCounts();
    expect(counts.DELIVERED).toBeUndefined();
    expect(counts.PENDING ?? 0).toBeGreaterThan(0);
  });

  it('sends no customer data across', async () => {
    const order = await h.placeOrder(10);
    await h.act(order.body.order_id, STORE_B, 'reject', { reason: 'Forklift broken at Askim' });
    await drain();
    const { rows } = await centralPool.query('SELECT payload, event_type, aggregate_id FROM inbox_events');
    expect(rows.length).toBeGreaterThan(3);
    expect(JSON.stringify(rows)).not.toMatch(/Nordbygg|Askim|Forklift|Demo Site|site\.manager|SE-SITE|SE-CUST/);
  });

  describe('demo reset', () => {
    const reset = async (body: object) =>
      h.api('POST', '/api/v1/admin/demo/reset', { token: await h.token('admin.se'), body });

    beforeEach(() => {
      h.config.demoResetEnabled = true;
    });

    it('is refused unless enabled, and only for admins, and needs the confirmation', async () => {
      expect((await h.api('POST', '/api/v1/admin/demo/reset', { token: await h.token('buyer.nordbygg'), body: { scenario: 'S1', confirm: 'RESET' } })).status).toBe(403);
      expect((await reset({ scenario: 'S1', confirm: 'yes' })).status).toBe(400);
      h.config.demoResetEnabled = false;
      const off = await reset({ scenario: 'S1', confirm: 'RESET' });
      expect(off.status).toBe(403);
      expect(off.body.error.code).toBe('DEMO_RESET_DISABLED');
    });

    it('resets all three systems to a scenario, and can start disconnected', async () => {
      const order = await h.placeOrder(30);
      await drain();
      expect(order.status).toBe(201);
      const done = await reset({ scenario: 'S2', confirm: 'RESET' });
      expect(done.body).toEqual({ scenario: 'S2', connector_enabled: true, central: 'reset' });
      expect((await h.stock(HUB)).on_hand).toBe(40);
      expect(Number((await h.pool.query('SELECT count(*) FROM orders')).rows[0].count)).toBe(0);
      expect((await dashboard()).kpis.total_orders).toBe(0);
      expect((await h.placeOrder(100)).body.fulfillable_qty).toBe(90);

      const off = await reset({ scenario: 'S1', confirm: 'RESET', connector: 'disabled' });
      expect(off.body.connector_enabled).toBe(false);
      const status = await h.api('GET', '/api/v1/system/status', { token: await h.token('staff.store-b') });
      expect(status.body).toMatchObject({ inventory_trusted: false, stale_reason: 'CONNECTOR_DISABLED', connector_enabled: false, source_reachable: false });
      await h.api('POST', '/api/v1/admin/connector/enable', { token: await h.token('admin.se') });
    });

    it('still resets the rest when Central is down, and says so', async () => {
      h.config.centralIngestUrl = 'http://127.0.0.1:9/ingest/events';
      const done = await reset({ scenario: 'S1', confirm: 'RESET' });
      expect(done.body.central).toBe('unreachable');
    });
  });

  it('gives staff the AI counters and says which provider is in use', async () => {
    const stats = await h.api('GET', '/api/v1/staff/normalization-reviews/stats', { token: await h.token('staff.store-b') });
    expect(stats.body).toMatchObject({ provider: 'mock', is_live_provider: false, auto_approval: false, ai_calls_total: 3 });
    expect((await h.api('GET', '/api/v1/staff/normalization-reviews/stats', { token: await h.token('buyer.nordbygg') })).status).toBe(403);
  });
});
