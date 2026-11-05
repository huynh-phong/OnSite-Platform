import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createPool, type Db } from '../src/db.js';
import { dropEverything, runMigrations } from '../src/migrate.js';
import { countryState } from '../src/services/dashboard.js';
import { filterPayload, resetCentral } from '../src/services/ingest.js';

const TOKEN = 'test-ingest-token';
const PASSWORD = 'test-admin-password';

function envValue(name: string): string {
  if (process.env[name]) return process.env[name]!;
  const file = readFileSync(new URL('../../../.env', import.meta.url), 'utf8');
  const line = file.split(/\r?\n/).find((entry) => entry.startsWith(`${name}=`));
  if (!line) throw new Error(`${name} is not set`);
  return line.slice(name.length + 1);
}

async function testDatabaseUrl(): Promise<string> {
  const url = new URL(envValue('CENTRAL_DATABASE_URL'));
  const testName = `${url.pathname.slice(1)}_test`;
  const admin = new pg.Client({ connectionString: url.toString() });
  await admin.connect();
  const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [testName]);
  if (!exists.rowCount) await admin.query(`CREATE DATABASE ${testName}`);
  await admin.end();
  url.pathname = `/${testName}`;
  return url.toString();
}

const event = (overrides: Record<string, unknown> = {}, payload: Record<string, unknown> = {}) => ({
  event_id: randomUUID(),
  event_type: 'order.approved.v1',
  origin_country: 'SE',
  aggregate_type: 'order',
  aggregate_id: 'SE-ORD-000001',
  aggregate_version: 3,
  occurred_at: new Date().toISOString(),
  payload: {
    status: 'APPROVED',
    sales_store_id: 'SE-STORE-B',
    shipment_count: 2,
    line_count: 1,
    at_risk: false,
    early_shortage_detected: false,
    otif: null,
    created_at: new Date().toISOString(),
    ...payload,
  },
  ...overrides,
});

describe('OnSite Central (real PostgreSQL)', () => {
  let pool: Db;
  let app: FastifyInstance;
  let cookie = '';

  const send = (body: unknown, token = TOKEN) =>
    app.inject({ method: 'POST', url: '/ingest/events', headers: { authorization: `Bearer ${token}` }, payload: body as object });
  const get = (url: string) => app.inject({ url, headers: { cookie } });
  const projection = async () => (await pool.query('SELECT * FROM order_projection')).rows;

  beforeAll(async () => {
    process.env.LOG_LEVEL = 'silent';
    pool = createPool(await testDatabaseUrl());
    await dropEverything(pool);
    await runMigrations(pool);
    app = await buildApp({ port: 0, databaseUrl: '', ingestToken: TOKEN, adminPassword: PASSWORD }, pool);
    const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { password: PASSWORD } });
    cookie = String(login.headers['set-cookie']).split(';')[0]!;
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });
  beforeEach(async () => {
    await resetCentral(pool);
  });

  describe('authentication', () => {
    it('refuses an event without the service token', async () => {
      const response = await app.inject({ method: 'POST', url: '/ingest/events', payload: event() });
      expect(response.statusCode).toBe(401);
      expect((await send(event(), 'wrong')).statusCode).toBe(401);
      expect(await projection()).toEqual([]);
    });

    it('protects the dashboard and admin actions with a session', async () => {
      for (const url of ['/dashboard', '/countries/status', '/events']) {
        expect((await app.inject({ url })).statusCode, url).toBe(401);
      }
      expect((await app.inject({ method: 'POST', url: '/admin/offline', payload: { enabled: true } })).statusCode).toBe(401);
      expect((await app.inject({ method: 'POST', url: '/admin/reset' })).statusCode).toBe(401);
      // The ingest token is not an admin login.
      const withToken = await app.inject({
        method: 'POST',
        url: '/admin/offline',
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { enabled: true },
      });
      expect(withToken.statusCode).toBe(401);
    });

    it('refuses a wrong password and a forged session; the cookie is HttpOnly', async () => {
      expect((await app.inject({ method: 'POST', url: '/auth/login', payload: { password: 'nope' } })).statusCode).toBe(401);
      expect((await app.inject({ url: '/dashboard', headers: { cookie: 'onsite_central_session=9999999999.forged' } })).statusCode).toBe(401);
      const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { password: PASSWORD } });
      expect(String(login.headers['set-cookie'])).toMatch(/HttpOnly; SameSite=Strict/);
      expect(login.body).not.toContain(TOKEN);
    });

    it('logging out ends the session in the browser', async () => {
      const response = await app.inject({ method: 'POST', url: '/auth/logout' });
      expect(String(response.headers['set-cookie'])).toContain('Max-Age=0');
      expect((await get('/auth/me')).json()).toEqual({ authenticated: true });
      expect((await app.inject({ url: '/auth/me' })).json()).toEqual({ authenticated: false });
    });

    it('has a public health check', async () => {
      const response = await app.inject({ url: '/health' });
      expect(response.json()).toEqual({ status: 'ok', db: 'ok', ingestion: 'online' });
    });
  });

  describe('validation', () => {
    it.each([
      ['a non-uuid event id', { event_id: 'abc' }],
      ['a missing type', { event_type: undefined }],
      ['a bad country', { origin_country: 'sweden' }],
      ['a bad version', { aggregate_version: 0 }],
      ['a bad timestamp', { occurred_at: 'yesterday' }],
      ['an aggregate id with spaces', { aggregate_id: 'Nordbygg AB' }],
      ['a missing payload', { payload: undefined }],
    ])('refuses %s with a non-retryable 400', async (_name, overrides) => {
      const response = await send(event(overrides));
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('VALIDATION_ERROR');
      expect(Number((await pool.query('SELECT count(*) FROM inbox_events')).rows[0].count)).toBe(0);
    });
  });

  describe('deduplication and ordering', () => {
    it('applies an event once; a redelivery is acknowledged but not counted', async () => {
      const first = event();
      expect((await send(first)).json()).toEqual({ result: 'applied' });
      expect((await send(first)).json()).toEqual({ result: 'duplicate' });
      const counts = (await pool.query('SELECT * FROM country_status')).rows[0];
      expect(Number(counts.events_received)).toBe(1);
      expect(Number(counts.duplicate_events_ignored)).toBe(1);
      expect((await get('/dashboard')).json().kpis.total_orders).toBe(1);
    });

    it('handles concurrent duplicates: one inbox row, the rest acknowledged', async () => {
      const one = event();
      const results = await Promise.all(Array.from({ length: 20 }, () => send(one)));
      expect(results.every((result) => result.statusCode === 200)).toBe(true);
      const outcomes = results.map((result) => result.json().result);
      expect(outcomes.filter((outcome) => outcome === 'applied')).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome === 'duplicate')).toHaveLength(19);
      expect(Number((await pool.query('SELECT count(*) FROM inbox_events')).rows[0].count)).toBe(1);
    });

    it('never lets an older version overwrite a newer projection', async () => {
      await send(event({ aggregate_version: 5 }, { status: 'DISPATCHED' }));
      const late = await send(event({ aggregate_version: 3 }, { status: 'APPROVED' }));
      expect(late.json()).toEqual({ result: 'out_of_order' });
      const [row] = await projection();
      expect(row).toMatchObject({ status: 'DISPATCHED', version: 5 });
      expect(Number((await pool.query('SELECT out_of_order_events FROM country_status')).rows[0].out_of_order_events)).toBe(1);
      // It is still on record.
      expect(Number((await pool.query('SELECT count(*) FROM inbox_events')).rows[0].count)).toBe(2);
    });

    it('ends on the highest version whatever the arrival order, even concurrently', async () => {
      const statuses = ['SUBMITTED', 'ALLOCATING', 'AWAITING_APPROVAL', 'APPROVED', 'DISPATCHING', 'DISPATCHED', 'DELIVERED'];
      const events = statuses.map((status, index) => event({ aggregate_version: index + 1 }, { status }));
      await Promise.all([...events].reverse().map((one) => send(one)));
      const [row] = await projection();
      expect(row).toMatchObject({ status: 'DELIVERED', version: 7 });
    });

    it('keeps orders separate', async () => {
      await send(event({ aggregate_id: 'SE-ORD-000001' }));
      await send(event({ aggregate_id: 'SE-ORD-000002', aggregate_version: 1 }, { status: 'SUBMITTED' }));
      expect(await projection()).toHaveLength(2);
    });

    it('accepts the same event id from another country as a different event', async () => {
      const id = randomUUID();
      expect((await send(event({ event_id: id }))).json().result).toBe('applied');
      expect((await send(event({ event_id: id, origin_country: 'DK' }))).json().result).toBe('applied');
    });
  });

  describe('privacy', () => {
    it('keeps only allow-listed fields', () => {
      expect(
        filterPayload({
          status: 'APPROVED',
          at_risk: false,
          company_name: 'Nordbygg AB',
          address: 'Demo Site 1',
          note: 'Left at gate',
          contact: { phone: '+46' },
        }),
      ).toEqual({ status: 'APPROVED', at_risk: false });
    });

    it('drops free text smuggled into an allowed field, and a value of the wrong type', () => {
      expect(filterPayload({ reason: 'Call Anna on +46 000 000', status: 'APPROVED', at_risk: 'yes' })).toEqual({ status: 'APPROVED' });
    });

    it('stores nothing beyond the allow-list, even if Local sent it', async () => {
      await send(event({}, { company_name: 'Nordbygg AB', site_address: 'Demo Site 1, Askim', note: 'Left at gate', contact: 'x@y.example' }));
      const { rows } = await pool.query('SELECT payload FROM inbox_events');
      const stored = JSON.stringify(rows);
      expect(stored).not.toMatch(/Nordbygg|Askim|Left at gate|x@y/);
      expect(rows[0].payload.status).toBe('APPROVED');
    });

    it('has no column that could hold customer data', async () => {
      const { rows } = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public'`);
      const columns = rows.map((row) => row.column_name).join(' ');
      expect(columns).not.toMatch(/customer|address|contact|phone|email|note|site/);
    });
  });

  describe('KPIs and lag', () => {
    it('computes KPIs from stored projections only', async () => {
      await send(event({ aggregate_id: 'SE-ORD-000001', aggregate_version: 2 }, { status: 'DELIVERED', otif: true }));
      await send(event({ aggregate_id: 'SE-ORD-000002', aggregate_version: 2 }, { status: 'DELIVERED', otif: false }));
      await send(event({ aggregate_id: 'SE-ORD-000003', aggregate_version: 2 }, { status: 'APPROVED', at_risk: true }));
      await send(event({ aggregate_id: 'SE-ORD-000004', aggregate_version: 2 }, { status: 'NEEDS_REVIEW', early_shortage_detected: true }));
      // A delivered order no longer counts as at risk.
      await send(event({ aggregate_id: 'SE-ORD-000005', aggregate_version: 2 }, { status: 'CANCELLED', at_risk: true }));
      const { kpis, orders_by_status: byStatus, data_is_simulated: simulated } = (await get('/dashboard')).json();
      expect(kpis).toEqual({
        total_orders: 5,
        at_risk_orders: 1,
        early_shortage_detected: 1,
        delivered_orders: 2,
        simulated_otif_rate: 0.5,
      });
      expect(byStatus).toEqual(expect.arrayContaining([{ status: 'DELIVERED', count: 2 }]));
      expect(simulated).toBe(true);
    });

    it('reports no OTIF until something is delivered, rather than a made-up zero', async () => {
      await send(event());
      expect((await get('/dashboard')).json().kpis.simulated_otif_rate).toBeNull();
    });

    it('measures the three Round 1 pilot KPIs from events, counting each once', async () => {
      const task = (order: string, version: number, type: string, node: string) =>
        event(
          { event_type: `task.${type}.v1`, aggregate_id: order, aggregate_version: version },
          { status: 'AWAITING_APPROVAL', node_id: node, task_status: type.toUpperCase() },
        );
      const warning = event(
        { event_type: 'order.at_risk.v1', aggregate_id: 'SE-ORD-000001', aggregate_version: 5 },
        { at_risk: true },
      );
      await send(warning);
      await send(warning); // redelivered
      // A second warning for the same order, after it cleared and came back, is still one warned order.
      await send(event({ event_type: 'order.at_risk.v1', aggregate_id: 'SE-ORD-000001', aggregate_version: 9 }, { at_risk: true }));
      await send(task('SE-ORD-000001', 6, 'approved', 'SE-STORE-B'));
      await send(task('SE-ORD-000001', 7, 'approved', 'SE-HUB-01'));
      await send(task('SE-ORD-000001', 8, 'delivered', 'SE-STORE-B'));
      await send(task('SE-ORD-000002', 3, 'rejected', 'SE-HUB-01'));
      // Store B approved, the hub never answered: only the hub missed its deadline.
      await send(task('SE-ORD-000003', 3, 'approved', 'SE-STORE-B'));
      await send(task('SE-ORD-000003', 4, 'expired', 'SE-HUB-01'));
      await send(task('SE-ORD-000003', 5, 'expired', 'SE-STORE-B'));
      // Moved off an offline node by the circuit breaker: nobody decided it.
      await send(
        event(
          { event_type: 'task.rejected.v1', aggregate_id: 'SE-ORD-000004', aggregate_version: 3 },
          { status: 'AWAITING_APPROVAL', node_id: 'SE-STORE-C', task_status: 'REJECTED', reason: 'NODE_OFFLINE' },
        ),
      );

      expect((await get('/dashboard')).json().pilot_kpis).toEqual({
        simulated_otif_rate: null,
        delay_warnings_sent: 1,
        tasks_handled_in_onsite: 4,
        tasks_missed_deadline: 1,
        adoption_rate: 0.8,
        deliveries_confirmed_digitally: 1,
      });
    });

    it('reports no adoption rate before any task was due', async () => {
      await send(event());
      expect((await get('/dashboard')).json().pilot_kpis).toMatchObject({ adoption_rate: null, delay_warnings_sent: 0 });
    });

    it('measures lag as applied time minus occurred time', async () => {
      const occurred = new Date(Date.now() - 5000).toISOString();
      await send(event({ occurred_at: occurred }));
      const { central_sync_lag_ms: lag } = (await get('/dashboard')).json();
      expect(lag.latest).toBeGreaterThanOrEqual(5000);
      expect(lag.latest).toBeLessThan(15000);
      expect(lag.p50).toBeGreaterThanOrEqual(5000);
      expect(lag.sampled_events).toBe(1);
    });

    it('lists event history newest first', async () => {
      await send(event({ aggregate_version: 1, event_type: 'order.submitted.v1' }, { status: 'SUBMITTED' }));
      await send(event({ aggregate_version: 2, event_type: 'order.allocating.v1' }, { status: 'ALLOCATING' }));
      const events = (await get('/events?limit=10')).json();
      expect(events.map((one: { event_type: string }) => one.event_type)).toEqual(['order.allocating.v1', 'order.submitted.v1']);
      expect(events[0]).toHaveProperty('sync_lag_ms');
    });

    it('shows Sweden as deployed and the other countries as future expansion only', async () => {
      await send(event());
      const countries = (await get('/countries/status')).json();
      expect(countries.map((c: { origin_country: string; state: string }) => [c.origin_country, c.state])).toEqual([
        ['SE', 'ACTIVE'],
        ['DK', 'FUTURE_EXPANSION'],
        ['NO', 'FUTURE_EXPANSION'],
      ]);
      expect(countries[1].deployed).toBe(false);
    });

    it('shows Sweden before any event has arrived', async () => {
      expect((await get('/countries/status')).json()[0]).toMatchObject({ origin_country: 'SE', state: 'NO_EVENTS_YET', deployed: true });
    });

    it('does not claim a quiet country is down', () => {
      const now = new Date('2026-11-09T12:00:00Z');
      expect(countryState(null, false, now)).toBe('NO_EVENTS_YET');
      expect(countryState(new Date('2026-11-09T11:59:00Z'), false, now)).toBe('ACTIVE');
      expect(countryState(new Date('2026-11-09T10:00:00Z'), false, now)).toBe('IDLE');
      expect(countryState(new Date('2026-11-09T11:59:00Z'), true, now)).toBe('INGESTION_OFFLINE');
    });
  });

  describe('simulated outage', () => {
    const offline = (enabled: boolean) => app.inject({ method: 'POST', url: '/admin/offline', headers: { cookie }, payload: { enabled } });

    it('refuses with a retryable 503, keeps the dashboard and data, then recovers without loss', async () => {
      const before = event({ aggregate_version: 1 }, { status: 'SUBMITTED' });
      await send(before);
      expect((await offline(true)).json()).toEqual({ ingestion_offline: true });

      const during = event({ aggregate_version: 2 }, { status: 'APPROVED' });
      const refused = await send(during);
      expect(refused.statusCode).toBe(503);
      expect(refused.json().error.code).toBe('CENTRAL_OFFLINE');

      const dashboard = await get('/dashboard');
      expect(dashboard.statusCode).toBe(200);
      expect(dashboard.json()).toMatchObject({ ingestion_offline: true, refused_while_offline: 1, kpis: { total_orders: 1 } });
      expect(dashboard.json().countries[0].state).toBe('INGESTION_OFFLINE');
      expect((await projection())[0]).toMatchObject({ status: 'SUBMITTED' });
      expect((await app.inject({ url: '/health' })).json().ingestion).toBe('simulated_offline');

      await offline(false);
      expect((await send(during)).json()).toEqual({ result: 'applied' });
      // A retry of something received before the outage changes nothing.
      expect((await send(before)).json()).toEqual({ result: 'duplicate' });
      expect((await projection())[0]).toMatchObject({ status: 'APPROVED', version: 2 });
      expect(Number((await pool.query('SELECT count(*) FROM inbox_events')).rows[0].count)).toBe(2);
    });
  });

  it('documents the required endpoints', async () => {
    const paths = (await app.inject({ url: '/docs/json' })).json().paths;
    for (const url of ['/ingest/events', '/dashboard', '/countries/status', '/admin/offline', '/health', '/events']) {
      expect(paths[url], url).toBeTruthy();
    }
  });
});
