import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createPool, type Db } from '../../src/db.js';
import { dropEverything, runMigrations } from '../../src/migrate.js';
import { sweepExpiredReservations } from '../../src/services/reservations.js';
import { seedSimulator } from '../../src/services/seed.js';

const TOKEN = 'test-service-token';
const auth = { authorization: `Bearer ${TOKEN}` };
const CEMENT = 'SE-CEM-025';
const B = 'SE-STORE-B';

function envValue(name: string): string {
  if (process.env[name]) return process.env[name]!;
  const file = readFileSync(new URL('../../../../.env', import.meta.url), 'utf8');
  const line = file.split(/\r?\n/).find((entry) => entry.startsWith(`${name}=`));
  if (!line) throw new Error(`${name} is not set in the environment or in .env`);
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

describe('Sweden simulator API (real PostgreSQL)', () => {
  let pool: Db;
  let app: FastifyInstance;

  const reserve = (qty: number, key: string, extra: Record<string, unknown> = {}) =>
    app.inject({
      method: 'POST',
      url: '/legacy/reservations',
      headers: { ...auth, 'idempotency-key': key },
      payload: { node_id: B, sku_id: CEMENT, qty, ttl_minutes: 30, ...extra },
    });
  const post = (url: string, payload?: unknown) =>
    app.inject({ method: 'POST', url, headers: auth, ...(payload === undefined ? {} : { payload: payload as object }) });
  const stock = async () =>
    (
      await pool.query<{ on_hand: number; reserved: number; version: number }>(
        'SELECT on_hand, reserved, version FROM inventory WHERE node_id = $1 AND sku_id = $2',
        [B, CEMENT],
      )
    ).rows[0]!;

  beforeAll(async () => {
    process.env.LOG_LEVEL = 'silent';
    pool = createPool(await testDatabaseUrl());
    await dropEverything(pool);
    await runMigrations(pool);
    app = await buildApp(pool, { serviceToken: TOKEN });
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });
  beforeEach(async () => {
    await seedSimulator(pool, 'S1');
  });

  it('requires the service token on /legacy/* but not on /health', async () => {
    expect((await app.inject({ url: '/legacy/stores' })).statusCode).toBe(401);
    expect((await app.inject({ url: '/legacy/stores', headers: { authorization: 'Bearer nope' } })).statusCode).toBe(401);
    expect((await app.inject({ url: '/health' })).statusCode).toBe(200);
  });

  it('lists 11 nodes and serves Swagger', async () => {
    const stores = (await app.inject({ url: '/legacy/stores', headers: auth })).json();
    expect(stores).toHaveLength(11);
    expect((await app.inject({ url: '/docs/json' })).json().paths).toHaveProperty('/legacy/reservations/{id}/extend');
  });

  describe('store server link', () => {
    const storeB = async () =>
      ((await app.inject({ url: '/legacy/stores', headers: auth })).json() as { store_id: string; link_up: boolean; last_heartbeat_at: string }[]).find(
        (store) => store.store_id === B,
      )!;

    it('reports a current heartbeat while the link is up', async () => {
      const store = await storeB();
      expect(store.link_up).toBe(true);
      expect(Date.now() - Date.parse(store.last_heartbeat_at)).toBeLessThan(5000);
    });

    it('freezes the heartbeat while the link is down, keeps stock usable, and recovers', async () => {
      const down = await post(`/legacy/admin/stores/${B}/link`, { up: false });
      expect(down.statusCode).toBe(200);
      const since = down.json().last_heartbeat_at;
      // Taking it down twice keeps the first time it went down.
      expect((await post(`/legacy/admin/stores/${B}/link`, { up: false })).json().last_heartbeat_at).toBe(since);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(await storeB()).toMatchObject({ link_up: false, last_heartbeat_at: since });
      // The ERP itself still answers for this node.
      expect((await reserve(1, 'link-down')).statusCode).toBe(201);

      expect((await post(`/legacy/admin/stores/${B}/link`, { up: true })).json().link_up).toBe(true);
      expect(Date.parse((await storeB()).last_heartbeat_at)).toBeGreaterThan(Date.parse(since));
    });

    it('refuses an unknown store, and a reseed brings every link back', async () => {
      expect((await post('/legacy/admin/stores/SE-NOPE/link', { up: false })).statusCode).toBe(404);
      await post(`/legacy/admin/stores/${B}/link`, { up: false });
      await seedSimulator(pool, 'S1');
      expect((await storeB()).link_up).toBe(true);
    });
  });

  describe('change feed', () => {
    it('returns a snapshot at cursor 0 and only later changes after that', async () => {
      const snapshot = (await app.inject({ url: '/legacy/inventory?since_seq=0', headers: auth })).json();
      expect(snapshot.items).toHaveLength(231);
      expect(snapshot.snapshot).toBe(true);
      expect(snapshot.next_seq).toBe(snapshot.head_seq);

      const empty = (await app.inject({ url: `/legacy/inventory?since_seq=${snapshot.next_seq}`, headers: auth })).json();
      expect(empty.items).toEqual([]);
      expect(empty.has_more).toBe(false);

      await post('/legacy/receipts', { node_id: B, sku_id: CEMENT, qty: 5 });
      const delta = (await app.inject({ url: `/legacy/inventory?since_seq=${snapshot.next_seq}`, headers: auth })).json();
      expect(delta.items).toHaveLength(1);
      expect(delta.items[0]).toMatchObject({ node_id: B, sku_id: CEMENT, on_hand: 65 });
      expect(delta.next_seq).toBeGreaterThan(snapshot.next_seq);
    });

    it('pages deltas without losing rows', async () => {
      const start = (await app.inject({ url: '/legacy/inventory?since_seq=0', headers: auth })).json().next_seq;
      for (const node of ['SE-STORE-A', 'SE-STORE-B', 'SE-STORE-D']) {
        await post('/legacy/receipts', { node_id: node, sku_id: CEMENT, qty: 1 });
      }
      const seen: string[] = [];
      let cursor = start;
      for (;;) {
        const page = (await app.inject({ url: `/legacy/inventory?since_seq=${cursor}&limit=2`, headers: auth })).json();
        seen.push(...page.items.map((row: { node_id: string }) => row.node_id));
        cursor = page.next_seq;
        if (!page.has_more) break;
      }
      expect(seen).toEqual(['SE-STORE-A', 'SE-STORE-B', 'SE-STORE-D']);
    });

    it('refuses cursors it can no longer honour', async () => {
      const page = (await app.inject({ url: '/legacy/inventory?since_seq=0', headers: auth })).json();
      const ahead = await app.inject({ url: `/legacy/inventory?since_seq=${page.head_seq + 100}`, headers: auth });
      expect(ahead.statusCode).toBe(409);
      expect(ahead.json().error.code).toBe('CURSOR_AHEAD');

      await post('/legacy/admin/feed/trim', { through_seq: 10 });
      const expired = await app.inject({ url: '/legacy/inventory?since_seq=5', headers: auth });
      expect(expired.statusCode).toBe(410);
      expect(expired.json().error.code).toBe('CURSOR_EXPIRED');
    });

    it('changes the epoch when the source is reseeded', async () => {
      const before = (await app.inject({ url: '/legacy/inventory?since_seq=0', headers: auth })).json().feed_epoch;
      await seedSimulator(pool, 'S1');
      const after = (await app.inject({ url: '/legacy/inventory?since_seq=0', headers: auth })).json().feed_epoch;
      expect(after).not.toBe(before);
    });

    it('delivers every concurrent change to a consumer that follows the cursor', async () => {
      let cursor = (await app.inject({ url: '/legacy/inventory?since_seq=0', headers: auth })).json().next_seq;
      const writes = Array.from({ length: 30 }, () => post('/legacy/receipts', { node_id: B, sku_id: CEMENT, qty: 1 }));
      let lastVersion = 0;
      let done = false;
      const all = Promise.all(writes).then(() => (done = true));
      while (!done) {
        const page = (await app.inject({ url: `/legacy/inventory?since_seq=${cursor}`, headers: auth })).json();
        for (const row of page.items) lastVersion = Math.max(lastVersion, row.version);
        cursor = page.next_seq;
      }
      await all;
      const final = (await app.inject({ url: `/legacy/inventory?since_seq=${cursor}`, headers: auth })).json();
      for (const row of final.items) lastVersion = Math.max(lastVersion, row.version);
      expect(lastVersion).toBe((await stock()).version);
    });
  });

  describe('atomic reservations', () => {
    it('reserves usable stock (on_hand - reserved - ceil(10%)) and refuses more', async () => {
      const ok = await reserve(54, 'k1');
      expect(ok.statusCode).toBe(201);
      expect(ok.json()).toMatchObject({ status: 'ACTIVE', qty: 54, inventory: { reserved: 54 } });
      const refused = await reserve(1, 'k2');
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error.code).toBe('INSUFFICIENT_STOCK');
      expect(await stock()).toMatchObject({ on_hand: 60, reserved: 54 });
    });

    it('never oversells under 20 concurrent callers', async () => {
      const results = await Promise.all(Array.from({ length: 20 }, (_, i) => reserve(10, `race-${i}`)));
      expect(results.filter((r) => r.statusCode === 201)).toHaveLength(5);
      expect(results.filter((r) => r.statusCode === 409)).toHaveLength(15);
      expect((await stock()).reserved).toBe(50);
    });

    it('is idempotent per key, including under concurrency, and rejects a changed body', async () => {
      const results = await Promise.all(Array.from({ length: 5 }, () => reserve(10, 'same')));
      expect(new Set(results.map((r) => r.json().reservation_id)).size).toBe(1);
      expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
      expect((await stock()).reserved).toBe(10);
      const changed = await reserve(11, 'same');
      expect(changed.statusCode).toBe(409);
      expect(changed.json().error.code).toBe('IDEMPOTENCY_CONFLICT');
    });

    it('commits once: on_hand and reserved fall together and the ledger gets one OUTBOUND row', async () => {
      const id = (await reserve(20, 'c1')).json().reservation_id;
      expect((await post(`/legacy/reservations/${id}/commit`)).json().status).toBe('COMMITTED');
      expect((await post(`/legacy/reservations/${id}/commit`)).statusCode).toBe(200);
      expect(await stock()).toMatchObject({ on_hand: 40, reserved: 0 });
      const rows = (await app.inject({ url: `/legacy/transactions?node_id=${B}&sku_id=${CEMENT}`, headers: auth })).json();
      expect(rows.filter((r: { type: string }) => r.type === 'OUTBOUND')).toHaveLength(1);
    });

    it('releases idempotently and refuses to release a committed reservation', async () => {
      const id = (await reserve(20, 'r1')).json().reservation_id;
      const del = () => app.inject({ method: 'DELETE', url: `/legacy/reservations/${id}`, headers: auth });
      expect((await del()).json().status).toBe('RELEASED');
      expect((await del()).json().status).toBe('RELEASED');
      expect((await stock()).reserved).toBe(0);

      const committed = (await reserve(5, 'r2')).json().reservation_id;
      await post(`/legacy/reservations/${committed}/commit`);
      expect((await app.inject({ method: 'DELETE', url: `/legacy/reservations/${committed}`, headers: auth })).statusCode).toBe(409);
    });

    it('releases by client key and tolerates a key that never arrived', async () => {
      await reserve(20, 'lost-response');
      const url = '/legacy/reservations?idempotency_key=';
      expect((await app.inject({ method: 'DELETE', url: `${url}lost-response`, headers: auth })).json().status).toBe('RELEASED');
      expect((await stock()).reserved).toBe(0);
      expect((await app.inject({ method: 'DELETE', url: `${url}never-sent`, headers: auth })).json().status).toBe('NOT_FOUND');
    });

    it('expires overdue reservations and gives the stock back', async () => {
      await reserve(20, 'e1', { ttl_minutes: 0.0001 });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(await sweepExpiredReservations(pool)).toBe(1);
      expect((await stock()).reserved).toBe(0);
      expect(await sweepExpiredReservations(pool)).toBe(0);
    });

    it('refuses to commit an overdue reservation the sweep has not reached', async () => {
      const id = (await reserve(20, 'e2', { ttl_minutes: 0.0001 })).json().reservation_id;
      await new Promise((resolve) => setTimeout(resolve, 20));
      const response = await post(`/legacy/reservations/${id}/commit`);
      expect(response.statusCode).toBe(409);
      expect(response.json().error.status).toBe('EXPIRED');
      expect(await stock()).toMatchObject({ on_hand: 60, reserved: 0 });
    });
  });

  describe('POST /legacy/reservations/:id/extend', () => {
    const extend = (id: string, ttl = 60) => post(`/legacy/reservations/${id}/extend`, { ttl_minutes: ttl });

    it('renews an active reservation without changing stock', async () => {
      const created = (await reserve(20, 'x1')).json();
      const before = await stock();
      const response = await extend(created.reservation_id);
      expect(response.statusCode).toBe(200);
      expect(Date.parse(response.json().expires_at)).toBeGreaterThan(Date.parse(created.expires_at));
      expect(response.json().extension_count).toBe(1);
      expect(await stock()).toEqual(before);
    });

    it('is safe to retry and never shortens a reservation', async () => {
      const created = (await reserve(20, 'x2')).json();
      const long = (await extend(created.reservation_id, 120)).json().expires_at;
      const short = (await extend(created.reservation_id, 1)).json().expires_at;
      expect(short).toBe(long);
    });

    it('handles concurrent renewals', async () => {
      const created = (await reserve(20, 'x3')).json();
      const results = await Promise.all(Array.from({ length: 10 }, () => extend(created.reservation_id)));
      expect(results.every((r) => r.statusCode === 200)).toBe(true);
      expect((await stock()).reserved).toBe(20);
    });

    it.each(['COMMITTED', 'RELEASED'])('refuses a %s reservation', async (status) => {
      const id = (await reserve(20, `x-${status}`)).json().reservation_id;
      if (status === 'COMMITTED') await post(`/legacy/reservations/${id}/commit`);
      else await app.inject({ method: 'DELETE', url: `/legacy/reservations/${id}`, headers: auth });
      const response = await extend(id);
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toMatchObject({ code: 'RESERVATION_NOT_ACTIVE', status });
    });

    it('refuses an expired reservation, even before the sweep, and frees the stock', async () => {
      const id = (await reserve(20, 'x4', { ttl_minutes: 0.0001 })).json().reservation_id;
      await new Promise((resolve) => setTimeout(resolve, 20));
      const response = await extend(id);
      expect(response.statusCode).toBe(409);
      expect(response.json().error.status).toBe('EXPIRED');
      expect((await stock()).reserved).toBe(0);
    });

    it('returns 404 for an unknown reservation and requires the service token', async () => {
      const unknown = '00000000-0000-4000-8000-000000000000';
      expect((await extend(unknown)).statusCode).toBe(404);
      const anonymous = await app.inject({
        method: 'POST',
        url: `/legacy/reservations/${unknown}/extend`,
        payload: { ttl_minutes: 60 },
      });
      expect(anonymous.statusCode).toBe(401);
    });

    it('shows the renewed expiry to GET and keeps the reservation past the original time', async () => {
      const id = (await reserve(20, 'x5', { ttl_minutes: 0.001 })).json().reservation_id;
      await extend(id, 60);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(await sweepExpiredReservations(pool)).toBe(0);
      const current = await app.inject({ url: `/legacy/reservations/${id}`, headers: auth });
      expect(current.json().status).toBe('ACTIVE');
    });
  });

  describe('POST /legacy/admin/outage', () => {
    it('makes other endpoints return 503, stays available itself, and recovers', async () => {
      const on = await post('/legacy/admin/outage', { enabled: true });
      expect(on.json()).toEqual({ enabled: true });

      for (const [method, url] of [
        ['GET', '/legacy/stores'],
        ['GET', '/legacy/products?since_seq=0'],
        ['GET', '/legacy/inventory?since_seq=0'],
        ['GET', '/legacy/transactions'],
        ['POST', '/legacy/receipts'],
        ['POST', '/legacy/reservations'],
      ] as const) {
        const response = await app.inject({ method, url, headers: auth });
        expect(response.statusCode, url).toBe(503);
        expect(response.json().error.code).toBe('SOURCE_UNAVAILABLE');
      }
      expect((await app.inject({ url: '/legacy/admin/outage', headers: auth })).json()).toEqual({ enabled: true });
      expect((await app.inject({ url: '/health' })).statusCode).toBe(200);

      expect((await post('/legacy/admin/outage', { enabled: false })).json()).toEqual({ enabled: false });
      expect((await app.inject({ url: '/legacy/stores', headers: auth })).statusCode).toBe(200);
    });

    it('requires authentication even during an outage', async () => {
      await post('/legacy/admin/outage', { enabled: true });
      expect(
        (await app.inject({ method: 'POST', url: '/legacy/admin/outage', payload: { enabled: false } })).statusCode,
      ).toBe(401);
    });
  });

  it('creates a product through the API once, then appears in the feed', async () => {
    const cursor = (await app.inject({ url: '/legacy/products?since_seq=0', headers: auth })).json().next_seq;
    const product = {
      sku_id: 'SE-NEW-1',
      name: 'Ny produkt',
      source_unit: 'säck',
      source_category: 'cement',
      source_description: 'Ny produkt 25kg säck',
      unit_price_sek: 10,
    };
    expect((await post('/legacy/products', product)).statusCode).toBe(201);
    expect((await post('/legacy/products', product)).statusCode).toBe(409);
    const delta = (await app.inject({ url: `/legacy/products?since_seq=${cursor}`, headers: auth })).json();
    expect(delta.items.map((p: { sku_id: string }) => p.sku_id)).toEqual(['SE-NEW-1']);
  });
});
