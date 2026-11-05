import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CEMENT, HUB, startHarness, STORE_B, type Harness } from './harness.js';

describe('Checkpoint 2: inventory sync and trust (Issue 2)', () => {
  let h: Harness;
  const freshness = () => h.app.container.inventory.freshness();
  const usable = async (node: string, sku = CEMENT) =>
    (await h.app.container.inventory.usableStock([sku])).find((row) => row.node_id === node)?.usable;
  const viewRow = async (node: string, sku = CEMENT) =>
    (await h.pool.query('SELECT * FROM inventory_view WHERE node_id = $1 AND sku_id = $2', [node, sku])).rows[0];
  const cursor = async () =>
    (await h.pool.query(`SELECT * FROM sync_cursors WHERE stream = 'inventory'`)).rows[0];

  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.reset('S1');
  });

  it('syncs the catalog and all stock from the simulator over HTTP', async () => {
    const count = async (table: string) => Number((await h.pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count);
    expect(await count('inventory_view')).toBe(231);
    expect(await count('products')).toBe(21);
    const active = await h.pool.query(`SELECT count(*) FROM products WHERE status = 'ACTIVE'`);
    expect(Number(active.rows[0].count)).toBe(20);
  });

  it('S1: Store B and the hub are each usable 54; other stores do not interfere', async () => {
    expect(await usable(STORE_B)).toBe(54);
    expect(await usable(HUB)).toBe(54);
    const stock = await h.app.container.inventory.usableStock([CEMENT]);
    expect(stock.filter((row) => row.usable > 0).map((row) => row.node_id).sort()).toEqual([HUB, STORE_B].sort());
  });

  it('S2: Store B usable 54, hub usable 36', async () => {
    await h.reset('S2');
    expect(await usable(STORE_B)).toBe(54);
    expect(await usable(HUB)).toBe(36);
  });

  it('picks up a change at the source through the delta feed', async () => {
    await h.simApi('POST', '/legacy/receipts', { node_id: STORE_B, sku_id: CEMENT, qty: 40 });
    expect(await usable(STORE_B)).toBe(54);
    await h.sync();
    expect(await usable(STORE_B)).toBe(90);
  });

  describe('stable inventory', () => {
    it('stays usable when the feed is verified, without faking any row timestamp', async () => {
      const before = await viewRow(STORE_B);
      const lastSyncBefore = (await cursor()).last_successful_sync_at;
      // Stock that has not changed for a long time at the source.
      await h.pool.query(`UPDATE inventory_view SET source_updated_at = now() - interval '30 days', ingested_at = now() - interval '30 days'`);
      const aged = await viewRow(STORE_B);

      await new Promise((resolve) => setTimeout(resolve, 5));
      expect((await h.sync()).ok).toBe(true);

      const after = await viewRow(STORE_B);
      expect(after.source_updated_at).toEqual(aged.source_updated_at);
      expect(after.ingested_at).toEqual(aged.ingested_at);
      expect(after.source_version).toBe(before.source_version);
      expect((await cursor()).last_successful_sync_at.getTime()).toBeGreaterThan(lastSyncBefore.getTime());
      expect((await freshness()).trusted).toBe(true);

      const order = await h.placeOrder(30);
      expect(order.body.status).toBe('AWAITING_APPROVAL');
    });

    it('moves source_updated_at and ingested_at only when the row actually changes', async () => {
      await h.pool.query(`UPDATE inventory_view SET ingested_at = now() - interval '1 day'`);
      const old = await viewRow(STORE_B);
      await h.simApi('POST', '/legacy/receipts', { node_id: STORE_B, sku_id: CEMENT, qty: 1 });
      await h.sync();
      const changed = await viewRow(STORE_B);
      expect(changed.ingested_at.getTime()).toBeGreaterThan(old.ingested_at.getTime());
      expect(changed.source_updated_at.getTime()).toBeGreaterThan(old.source_updated_at.getTime());
      const untouched = await viewRow(HUB);
      expect(untouched.ingested_at.getTime()).toBe(old.ingested_at.getTime());
    });
  });

  describe('real stale data', () => {
    it('stops trusting the view when no sync has verified it within the threshold', async () => {
      await h.pool.query(`UPDATE sync_cursors SET last_successful_sync_at = now() - interval '5 minutes'`);
      expect(await freshness()).toMatchObject({ trusted: false, staleReason: 'SYNC_TOO_OLD' });
    });

    it('honours the configured threshold', async () => {
      await h.pool.query(`UPDATE sync_cursors SET last_successful_sync_at = now() - interval '90 seconds'`);
      expect((await freshness()).trusted).toBe(false);
      h.config.inventory.staleAfterSeconds = 300;
      expect((await freshness()).trusted).toBe(true);
      h.config.inventory.staleAfterSeconds = 60;
    });

    it('a new order refreshes a merely old view by itself rather than refusing', async () => {
      await h.pool.query(`UPDATE sync_cursors SET last_successful_sync_at = now() - interval '5 minutes'`);
      expect((await h.placeOrder(10)).body.status).toBe('AWAITING_APPROVAL');
    });
  });

  describe('outage and recovery', () => {
    it('withdraws trust on a failed sync and recovers without a restart', async () => {
      await h.outage(true);
      const failed = await h.sync();
      expect(failed).toMatchObject({ ok: false, error: 'SOURCE_UNAVAILABLE' });
      expect(await freshness()).toMatchObject({ trusted: false, staleReason: 'LAST_SYNC_FAILED' });
      expect((await cursor()).consecutive_failures).toBe(1);

      const health = await h.api('GET', '/api/v1/health');
      expect(health.status).toBe(200);
      expect(health.body).toMatchObject({ status: 'degraded', simulator: 'down', db: 'ok' });

      await h.outage(false);
      expect((await h.sync()).ok).toBe(true);
      expect((await freshness()).trusted).toBe(true);
      expect((await cursor()).consecutive_failures).toBe(0);
      expect((await h.api('GET', '/api/v1/health')).body.status).toBe('ok');
    });

    it('catches up on changes made while it could not reach the source', async () => {
      await h.outage(true);
      await h.sync();
      await h.outage(false);
      await h.simApi('POST', '/legacy/receipts', { node_id: STORE_B, sku_id: CEMENT, qty: 40 });
      await h.sync();
      expect(await usable(STORE_B)).toBe(90);
    });

    it('never commits stock during an outage even if the last sync was good', async () => {
      await h.outage(true);
      const order = await h.placeOrder(30);
      expect(order.status).toBe(201);
      expect(order.body).toMatchObject({ status: 'NEEDS_REVIEW', review_reason: 'SOURCE_UNAVAILABLE' });
      await h.outage(false);
      expect((await h.stock(STORE_B)).reserved).toBe(0);
    });

    it('the admin connector switch stops trust and orders, and turning it back on recovers', async () => {
      const admin = await h.token('admin.se');
      expect((await h.api('POST', '/api/v1/admin/connector/disable', { token: admin })).body).toEqual({ enabled: false });
      expect(await freshness()).toMatchObject({ trusted: false, staleReason: 'CONNECTOR_DISABLED' });
      expect((await h.sync()).ok).toBe(false);
      expect((await h.api('GET', '/api/v1/health')).body.simulator).toBe('disabled');
      const refused = await h.placeOrder(10);
      expect(refused.body).toMatchObject({ status: 'NEEDS_REVIEW', review_reason: 'SOURCE_UNAVAILABLE' });

      await h.api('POST', '/api/v1/admin/connector/enable', { token: admin });
      expect((await h.sync()).ok).toBe(true);
      expect((await h.placeOrder(10)).body.status).toBe('AWAITING_APPROVAL');
    });
  });

  describe('feed continuity', () => {
    it('treats a missing cursor as untrusted, then rebuilds from a snapshot', async () => {
      await h.pool.query(`DELETE FROM sync_cursors WHERE stream = 'inventory'`);
      expect(await freshness()).toMatchObject({ trusted: false, staleReason: 'NO_CURSOR' });
      expect((await h.sync()).ok).toBe(true);
      expect((await freshness()).trusted).toBe(true);
      expect(await usable(STORE_B)).toBe(54);
    });

    it('takes a snapshot when the cursor is older than the feed keeps', async () => {
      await h.simApi('POST', '/legacy/receipts', { node_id: STORE_B, sku_id: CEMENT, qty: 40 });
      const current = Number((await cursor()).last_seq);
      await h.simApi('POST', '/legacy/admin/feed/trim', { through_seq: current + 1 });
      expect((await h.sync()).ok).toBe(true);
      expect((await freshness()).trusted).toBe(true);
      expect(await usable(STORE_B)).toBe(90);
    });

    it('takes a snapshot when the cursor is ahead of the feed', async () => {
      await h.pool.query(`UPDATE sync_cursors SET last_seq = 99999999`);
      expect((await h.sync()).ok).toBe(true);
      expect((await freshness()).trusted).toBe(true);
    });

    it('does not trust a broken cursor until the snapshot has actually been applied', async () => {
      const current = Number((await cursor()).last_seq);
      await h.simApi('POST', '/legacy/admin/feed/trim', { through_seq: current + 1 });
      await h.outage(true);
      expect((await h.sync()).ok).toBe(false);
      expect((await freshness()).trusted).toBe(false);
      await h.outage(false);
      expect((await h.sync()).ok).toBe(true);
      expect((await freshness()).trusted).toBe(true);
    });

    it('takes a snapshot, replacing stock, when the source was reset', async () => {
      await h.simApi('POST', '/legacy/receipts', { node_id: STORE_B, sku_id: CEMENT, qty: 40 });
      await h.sync();
      expect(await usable(STORE_B)).toBe(90);
      const { seedSimulator } = await import('../../../sweden-simulator/src/services/seed.js');
      await seedSimulator(h.simPool, 'S2');
      expect((await h.sync()).ok).toBe(true);
      expect(await usable(HUB)).toBe(36);
      expect(await usable(STORE_B)).toBe(54);
    });
  });

  it('excludes stock awaiting normalization, and applies a verified 1:1 unit once approved', async () => {
    const usableAtC = await usable('SE-STORE-C', 'SE-CEM-040');
    expect(usableAtC).toBe(0);
    const admin = await h.token('admin.se');
    const reviews = await h.api('GET', '/api/v1/staff/normalization-reviews?status=PENDING', { token: admin });
    const st = reviews.body.find((review: { raw_value: string }) => review.raw_value === 'st');
    expect(st.pending_record_count).toBe(21);
    expect((await h.api('POST', `/api/v1/staff/normalization-reviews/${st.review_id}/approve`, { token: admin })).status).toBe(200);
    expect(await usable('SE-STORE-C', 'SE-CEM-040')).toBe(72);
  });

  it('keeps stock in pieces out of usable for a product sold by length: no conversion is guessed', async () => {
    const admin = await h.token('admin.se');
    const reviews = await h.api('GET', '/api/v1/staff/normalization-reviews?status=PENDING', { token: admin });
    const st = reviews.body.find((review: { raw_value: string }) => review.raw_value === 'st');
    expect((await h.api('POST', `/api/v1/staff/normalization-reviews/${st.review_id}/approve`, { token: admin })).status).toBe(200);
    expect(await usable('SE-STORE-C', 'SE-TIM-4595')).toBe(0);
    expect(await usable('SE-STORE-A', 'SE-TIM-4595')).toBe(72);
  });
});
