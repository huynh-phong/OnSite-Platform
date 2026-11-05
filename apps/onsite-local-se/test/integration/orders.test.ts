import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword } from '../../src/passwords.js';
import { CEMENT, HUB, NEAR_SITE, startHarness, STORE_B, type Harness } from './harness.js';

describe('Checkpoint 3: orders core', () => {
  let h: Harness;

  const activeReservations = async (orderId: string) =>
    (
      await h.pool.query(
        `SELECT a.node_id, a.quantity FROM reservations r JOIN allocations a USING (allocation_id) JOIN order_items i USING (item_id)
          WHERE i.order_id = $1 AND r.status = 'ACTIVE' ORDER BY a.node_id`,
        [orderId],
      )
    ).rows;
  const sourceReservations = async (node: string) =>
    (await h.simPool.query(`SELECT qty FROM reservations WHERE node_id = $1 AND status = 'ACTIVE'`, [node])).rows;

  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.reset('S1');
  });

  describe('authentication', () => {
    it('logs in with the demo password and issues the claims in the JWT', async () => {
      const response = await h.api('POST', '/api/v1/auth/login', {
        body: { username: 'staff.store-b', password: h.config.demoPassword },
      });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ role: 'staff', store_id: STORE_B, country: 'SE', expires_in: 28800 });
      const claims = JSON.parse(Buffer.from(response.body.access_token.split('.')[1], 'base64url').toString());
      expect(claims).toMatchObject({ sub: 'staff.store-b', role: 'staff', country: 'SE', store_id: STORE_B });
      expect(claims.exp - claims.iat).toBe(28800);
    });

    it('refuses wrong credentials the same way for known and unknown users', async () => {
      for (const username of ['staff.store-b', 'nobody']) {
        const response = await h.api('POST', '/api/v1/auth/login', { body: { username, password: 'wrong' } });
        expect(response.status).toBe(401);
        expect(response.body.error.code).toBe('INVALID_CREDENTIALS');
      }
    });

    it.each([
      ['GET', '/api/v1/stores'],
      ['GET', '/api/v1/products'],
      ['GET', '/api/v1/orders'],
      ['POST', '/api/v1/orders'],
      ['GET', '/api/v1/orders/SE-ORD-000001'],
      ['GET', '/api/v1/staff/tasks'],
      ['GET', '/api/v1/staff/normalization-reviews'],
      ['GET', '/api/v1/metrics'],
      ['GET', '/api/v1/stream'],
    ] as const)('%s %s requires a token', async (method, url) => {
      const response = await h.api(method, url, method === 'POST' ? { body: {}, headers: { 'idempotency-key': 'k' } } : {});
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('UNAUTHORIZED');
    });

    it('enforces roles on the server', async () => {
      const staff = await h.token('staff.store-b');
      const buyer = await h.token('buyer.nordbygg');
      expect((await h.placeOrder(5, { token: staff })).status).toBe(403);
      expect((await h.api('GET', '/api/v1/staff/tasks', { token: buyer })).status).toBe(403);
      expect((await h.api('GET', '/api/v1/metrics', { token: staff })).status).toBe(403);
      expect((await h.api('POST', '/api/v1/admin/connector/disable', { token: buyer })).status).toBe(403);
      expect((await h.api('GET', '/api/v1/staff/normalization-reviews', { token: buyer })).status).toBe(403);
    });
  });

  describe('catalog', () => {
    it('lists 11 nodes', async () => {
      const response = await h.api('GET', '/api/v1/stores', { token: await h.token('buyer.nordbygg') });
      expect(response.body).toHaveLength(11);
    });

    it('shows a customer ACTIVE products with availability but no stock numbers, and hides pending ones', async () => {
      const response = await h.api('GET', '/api/v1/products', { token: await h.token('buyer.nordbygg') });
      const skus = response.body.map((p: { sku_id: string }) => p.sku_id);
      expect(skus).toHaveLength(20);
      expect(skus).not.toContain('SE-CEM-STD-025');
      const cement = response.body.find((p: { sku_id: string }) => p.sku_id === CEMENT);
      expect(cement).toMatchObject({ availability: 'AVAILABLE', unit_price_sek: 89, pack_size_kg: 25, base_unit: 'bag' });
      expect(cement.inventory_as_of).toBeTruthy();
      expect(cement).not.toHaveProperty('usable_by_node');
    });

    it('gives staff stock per node and optional pending products', async () => {
      const staff = await h.token('staff.store-b');
      const response = await h.api('GET', '/api/v1/products?include_pending=true', { token: staff });
      expect(response.body).toHaveLength(21);
      const cement = response.body.find((p: { sku_id: string }) => p.sku_id === CEMENT);
      expect(cement.usable_by_node).toEqual(
        expect.arrayContaining([
          { node_id: STORE_B, usable: 54 },
          { node_id: HUB, usable: 54 },
        ]),
      );
    });

    it('a customer asking for pending products still does not see them', async () => {
      const response = await h.api('GET', '/api/v1/products?include_pending=true', { token: await h.token('buyer.nordbygg') });
      expect(response.body).toHaveLength(20);
    });

    it('reports availability as UNKNOWN when stock cannot be trusted', async () => {
      await h.outage(true);
      await h.sync();
      const response = await h.api('GET', '/api/v1/products', { token: await h.token('buyer.nordbygg') });
      expect(response.body[0].availability).toBe('UNKNOWN');
    });

    it('lists only the customer\'s own sites, with decrypted addresses', async () => {
      const response = await h.api('GET', '/api/v1/sites', { token: await h.token('buyer.nordbygg') });
      expect(response.body.map((s: { site_id: string }) => s.site_id)).toEqual(['SE-SITE-001', 'SE-SITE-002']);
      expect(response.body[0].address).toContain('Askim');
    });
  });

  describe('T01 and T02: allocation', () => {
    it('T01: 30 bags, Store B has enough: one task, one reservation, AWAITING_APPROVAL', async () => {
      const response = await h.placeOrder(30);
      expect(response.status).toBe(201);
      expect(response.body.status).toBe('AWAITING_APPROVAL');
      expect(response.body.order_id).toMatch(/^SE-ORD-\d{6}$/);
      expect(response.body.allocations).toHaveLength(1);
      expect(response.body.allocations[0]).toMatchObject({ node_id: STORE_B, sku_id: CEMENT, quantity: 30 });
      expect(response.body.allocations[0].reason).toContain('km');
      expect(response.body.inventory_as_of).toBeTruthy();
      expect(response.body.reservation_expires_at).toBeTruthy();
      expect(response.body.eta).toBeTruthy();
      expect(response.body.shipments).toHaveLength(1);
      expect(response.body.shipments[0].eta_inputs.provisional).toBe(true);
      expect(await h.tasks(response.body.order_id)).toHaveLength(1);
      expect(await activeReservations(response.body.order_id)).toEqual([{ node_id: STORE_B, quantity: 30 }]);
      expect(await h.stock(STORE_B)).toEqual({ on_hand: 60, reserved: 30 });
    });

    it('T02 (S1): 100 bags split 54 + 46: two tasks, two reservations', async () => {
      const response = await h.placeOrder(100);
      expect(response.body.status).toBe('AWAITING_APPROVAL');
      expect(response.body.allocations.map((a: { node_id: string; quantity: number }) => [a.node_id, a.quantity])).toEqual([
        [STORE_B, 54],
        [HUB, 46],
      ]);
      expect(await h.tasks(response.body.order_id)).toHaveLength(2);
      expect(await h.stock(STORE_B)).toEqual({ on_hand: 60, reserved: 54 });
      expect(await h.stock(HUB)).toEqual({ on_hand: 60, reserved: 46 });
    });

    it('T03 (S2): 100 bags: NEEDS_REVIEW, fulfillable 90, nothing held', async () => {
      await h.reset('S2');
      const response = await h.placeOrder(100);
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        status: 'NEEDS_REVIEW',
        review_reason: 'INSUFFICIENT_STOCK',
        fulfillable_qty: 90,
        early_shortage_detected: true,
      });
      expect(await activeReservations(response.body.order_id)).toEqual([]);
      expect(await h.stock(STORE_B)).toEqual({ on_hand: 40 + 20, reserved: 0 });
      expect(await h.stock(HUB)).toEqual({ on_hand: 40, reserved: 0 });
      expect(await h.tasks(response.body.order_id)).toEqual([]);
    });

    it('uses reserved stock for the next order without waiting for a sync', async () => {
      await h.placeOrder(54);
      const second = await h.placeOrder(10);
      expect(second.body.allocations[0].node_id).toBe(HUB);
    });

    it('refuses an unknown or pending product, a wrong unit, an unknown store, and someone else\'s site', async () => {
      expect((await h.placeOrder(1, { sku: 'NOPE' })).body.error.code).toBe('PRODUCT_NOT_AVAILABLE');
      expect((await h.placeOrder(1, { sku: 'SE-CEM-STD-025' })).body.error.code).toBe('PRODUCT_NOT_AVAILABLE');
      expect((await h.placeOrder(1, { unit: 'pallet' })).body.error.code).toBe('UNIT_MISMATCH');
      const site = await h.placeOrder(1, { site: 'SE-SITE-999' });
      expect(site.status).toBe(422);
      const noOrders = await h.pool.query('SELECT count(*) FROM orders');
      expect(Number(noOrders.rows[0].count)).toBe(0);
    });

    it('validates the request', async () => {
      const buyer = await h.token('buyer.nordbygg');
      const post = (body: object, headers: Record<string, string> = { 'idempotency-key': randomUUID() }) =>
        h.api('POST', '/api/v1/orders', { token: buyer, headers, body });
      const valid = {
        sales_store_id: STORE_B,
        site_id: NEAR_SITE,
        requested_delivery_at: new Date().toISOString(),
        items: [{ sku_id: CEMENT, quantity: 1, unit: 'bag' }],
      };
      expect((await post(valid, {})).status).toBe(400);
      expect((await post({ ...valid, items: [] })).status).toBe(400);
      expect((await post({ ...valid, items: [{ sku_id: CEMENT, quantity: 0, unit: 'bag' }] })).status).toBe(400);
      expect((await post({ ...valid, items: [{ sku_id: CEMENT, quantity: -5, unit: 'bag' }] })).status).toBe(400);
      expect((await post({ ...valid, requested_delivery_at: 'tomorrow' })).status).toBe(400);
      const past = await post({ ...valid, requested_delivery_at: new Date(Date.now() - 3600_000).toISOString() });
      expect(past.status).toBe(422);
      expect(past.body.error).toMatchObject({ code: 'DELIVERY_IN_PAST' });
      const failed = await post({ ...valid, items: [] });
      expect(failed.body.error).toMatchObject({ code: 'VALIDATION_ERROR' });
    });
  });

  describe('T04: concurrency', () => {
    it('20 concurrent orders for the last units never oversell', async () => {
      const results = await Promise.all(Array.from({ length: 20 }, () => h.placeOrder(10)));
      expect(results.every((result) => result.status === 201)).toBe(true);
      const won = results.filter((result) => result.body.status === 'AWAITING_APPROVAL');
      const review = results.filter((result) => result.body.status === 'NEEDS_REVIEW');
      expect(won.length + review.length).toBe(20);

      const b = await h.stock(STORE_B);
      const hub = await h.stock(HUB);
      expect(b.reserved).toBeLessThanOrEqual(54);
      expect(hub.reserved).toBeLessThanOrEqual(54);
      expect(b.reserved).toBeGreaterThanOrEqual(0);
      expect(hub.reserved).toBeGreaterThanOrEqual(0);
      // Local and the source agree on what is held, and a loser keeps nothing.
      expect(b.reserved + hub.reserved).toBe(won.length * 10);
      const { rows } = await h.simPool.query(`SELECT coalesce(sum(qty), 0)::int AS held FROM reservations WHERE status = 'ACTIVE'`);
      expect(rows[0].held).toBe(won.length * 10);
      for (const loser of review) expect(await activeReservations(loser.body.order_id)).toEqual([]);
      expect(won.length).toBeGreaterThan(0);
    });

    it('the source refusing on stale data triggers a re-plan, not an oversell', async () => {
      // The source sells stock Local does not know about yet.
      await h.simApi(
        'POST',
        '/legacy/reservations',
        { node_id: STORE_B, sku_id: CEMENT, qty: 50, ttl_minutes: 30 },
        { 'idempotency-key': 'outside-1' },
      );
      const response = await h.placeOrder(30);
      expect(response.body.status).toBe('AWAITING_APPROVAL');
      expect(response.body.allocations[0].node_id).toBe(HUB);
      const metrics = await h.api('GET', '/api/v1/metrics', { token: await h.token('admin.se') });
      expect(metrics.body.reservations.reservation_conflicts).toBe(1);
      expect((await h.stock(STORE_B)).reserved).toBe(50);
    });

    it('a failure half-way through a split releases what was held', async () => {
      await h.simApi(
        'POST',
        '/legacy/reservations',
        { node_id: HUB, sku_id: CEMENT, qty: 54, ttl_minutes: 30 },
        { 'idempotency-key': 'outside-2' },
      );
      const response = await h.placeOrder(100);
      expect(response.body).toMatchObject({ status: 'NEEDS_REVIEW', review_reason: 'INSUFFICIENT_STOCK', fulfillable_qty: 54 });
      expect((await h.stock(STORE_B)).reserved).toBe(0);
      expect(await activeReservations(response.body.order_id)).toEqual([]);
    });

    it('source down during the reservation calls releases and reports SOURCE_UNAVAILABLE', async () => {
      await h.simApi(
        'POST',
        '/legacy/reservations',
        { node_id: HUB, sku_id: CEMENT, qty: 1, ttl_minutes: 30 },
        { 'idempotency-key': 'noop' },
      );
      await h.sync();
      await h.outage(true);
      const response = await h.placeOrder(100);
      expect(response.body).toMatchObject({ status: 'NEEDS_REVIEW', review_reason: 'SOURCE_UNAVAILABLE' });
      await h.outage(false);
      await h.app.container.reservations.tick();
      expect((await h.stock(STORE_B)).reserved).toBe(0);
    });
  });

  describe('T05: idempotency', () => {
    it('the same key twice gives one order and the same response', async () => {
      const key = randomUUID();
      const first = await h.placeOrder(30, { key });
      const second = await h.placeOrder(30, { key });
      expect(second.status).toBe(201);
      expect(second.body).toEqual(first.body);
      expect(Number((await h.pool.query('SELECT count(*) FROM orders')).rows[0].count)).toBe(1);
      expect((await h.stock(STORE_B)).reserved).toBe(30);
    });

    it('the same key with a different body is a 409', async () => {
      const key = randomUUID();
      await h.placeOrder(30, { key });
      const conflict = await h.placeOrder(31, { key });
      expect(conflict.status).toBe(409);
      expect(conflict.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
      expect(Number((await h.pool.query('SELECT count(*) FROM orders')).rows[0].count)).toBe(1);
    });

    it('a retry gets the stored answer even if the product has since become unavailable', async () => {
      const key = randomUUID();
      const first = await h.placeOrder(5, { key });
      await h.pool.query(`UPDATE products SET status = 'PENDING_REVIEW' WHERE sku_id = $1`, [CEMENT]);
      const retry = await h.placeOrder(5, { key });
      expect(retry.status).toBe(201);
      expect(retry.body).toEqual(first.body);
    });

    it('concurrent retries of one key create one order', async () => {
      const key = randomUUID();
      const requestedAt = new Date(Date.now() + 86400000).toISOString();
      const results = await Promise.all(Array.from({ length: 5 }, () => h.placeOrder(10, { key, requestedAt })));
      expect(results.filter((r) => r.status === 201).length).toBeGreaterThan(0);
      for (const result of results.filter((r) => r.status !== 201)) {
        expect(result.body.error.code).toBe('IDEMPOTENCY_IN_PROGRESS');
      }
      expect(Number((await h.pool.query('SELECT count(*) FROM orders')).rows[0].count)).toBe(1);
      expect((await h.stock(STORE_B)).reserved).toBe(10);
    });

    it('keys belong to the principal: another customer may use the same key', async () => {
      const second = await createSecondCustomer();
      const key = randomUUID();
      await h.placeOrder(5, { key });
      const other = await h.api('POST', '/api/v1/orders', {
        token: second,
        headers: { 'idempotency-key': key },
        body: {
          sales_store_id: STORE_B,
          site_id: 'SE-SITE-901',
          requested_delivery_at: new Date(Date.now() + 86400000).toISOString(),
          items: [{ sku_id: CEMENT, quantity: 5, unit: 'bag' }],
        },
      });
      expect(other.status).toBe(201);
      expect(Number((await h.pool.query('SELECT count(*) FROM orders')).rows[0].count)).toBe(2);
    });
  });

  async function createSecondCustomer(): Promise<string> {
    const zero = Buffer.alloc(1);
    await h.pool.query(
      `INSERT INTO customers (customer_id, company_name, contact_enc, contact_nonce, contact_tag, key_id)
       VALUES ('SE-CUST-900', 'Other AB', $1, $1, $1, 'se-key-v1')`,
      [zero],
    );
    await h.pool.query(
      `INSERT INTO sites (site_id, customer_id, lat, lng, address_enc, address_nonce, address_tag, key_id)
       VALUES ('SE-SITE-901', 'SE-CUST-900', 57.63, 11.93, $1, $1, $1, 'se-key-v1')`,
      [zero],
    );
    await h.pool.query(
      `INSERT INTO users (user_id, password_hash, role, country, customer_id) VALUES ('buyer.other', $1, 'customer', 'SE', 'SE-CUST-900')`,
      [hashPassword(h.config.demoPassword)],
    );
    return h.token('buyer.other');
  }

  describe('T06: node and customer scope', () => {
    it('staff.store-b acting on the hub task gets a 403 and an audit row', async () => {
      const order = await h.placeOrder(100);
      const hubTask = (await h.tasks(order.body.order_id)).find((task) => task.node_id === HUB)!;
      const token = await h.token('staff.store-b');
      for (const action of ['approve', 'dispatch', 'deliver']) {
        const response = await h.api('POST', `/api/v1/staff/tasks/${hubTask.task_id}/${action}`, {
          token,
          body: { version: hubTask.version, delivered_qty: 1 },
        });
        expect(response.status).toBe(403);
        expect(response.body.error.code).toBe('FORBIDDEN');
      }
      const reject = await h.api('POST', `/api/v1/staff/tasks/${hubTask.task_id}/reject`, {
        token,
        body: { version: hubTask.version, reason: 'not mine' },
      });
      expect(reject.status).toBe(403);
      const { rows } = await h.pool.query(`SELECT * FROM audit_logs WHERE result = '403' AND resource = $1`, [
        `/api/v1/staff/tasks/${hubTask.task_id}/approve`,
      ]);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actor: 'staff.store-b', action: 'POST /api/v1/staff/tasks/:id/approve' });
      expect(rows[0].request_id).toBeTruthy();
      expect((await h.tasks(order.body.order_id)).every((task) => task.status === 'PENDING_APPROVAL')).toBe(true);
    });

    it('staff see only their own node\'s tasks and cannot get another node\'s picking list', async () => {
      const order = await h.placeOrder(100);
      const list = await h.api('GET', '/api/v1/staff/tasks?status=PENDING_APPROVAL', { token: await h.token('staff.store-b') });
      expect(list.body.map((task: { node_id: string }) => task.node_id)).toEqual([STORE_B]);
      const hubTask = (await h.tasks(order.body.order_id)).find((task) => task.node_id === HUB)!;
      const picklist = await h.api('GET', `/api/v1/staff/tasks/${hubTask.task_id}/picklist`, { token: await h.token('staff.store-b') });
      expect(picklist.status).toBe(403);
      const unrelated = await h.api('GET', `/api/v1/orders/${order.body.order_id}`, { token: await h.token('staff.store-c') });
      expect(unrelated.status).toBe(403);
    });

    it('a store_id in the request is ignored: scope comes from the token', async () => {
      const order = await h.placeOrder(100);
      const list = await h.api('GET', `/api/v1/staff/tasks?store_id=${HUB}&node_id=${HUB}`, { token: await h.token('staff.store-b') });
      expect(list.body.every((task: { node_id: string }) => task.node_id === STORE_B)).toBe(true);
      expect(order.status).toBe(201);
    });

    it('customers see only their own orders', async () => {
      const order = await h.placeOrder(5);
      const other = await createSecondCustomer();
      const response = await h.api('GET', `/api/v1/orders/${order.body.order_id}`, { token: other });
      expect(response.status).toBe(403);
      const audit = await h.pool.query(`SELECT 1 FROM audit_logs WHERE actor = 'buyer.other' AND result = '403'`);
      expect(audit.rowCount).toBe(1);
      expect((await h.api('GET', '/api/v1/orders', { token: other })).body).toEqual([]);
      expect((await h.api('POST', `/api/v1/orders/${order.body.order_id}/cancel`, { token: other })).status).toBe(403);
    });

    it('a customer cannot order to another customer\'s site', async () => {
      const other = await createSecondCustomer();
      const response = await h.placeOrder(1, { token: other, site: NEAR_SITE });
      expect(response.status).toBe(403);
    });
  });

  describe('optimistic locking and approval', () => {
    it('a stale version is a 409 and changes nothing', async () => {
      const order = await h.placeOrder(30);
      const [task] = await h.tasks(order.body.order_id);
      const token = await h.token('staff.store-b');
      const stale = await h.api('POST', `/api/v1/staff/tasks/${task!.task_id}/approve`, {
        token,
        body: { version: task!.version + 7 },
      });
      expect(stale.status).toBe(409);
      expect(stale.body.error.code).toBe('VERSION_CONFLICT');
      expect((await h.tasks(order.body.order_id))[0]!.status).toBe('PENDING_APPROVAL');
    });

    it('of two concurrent approvals with one version, exactly one wins', async () => {
      const order = await h.placeOrder(30);
      const [task] = await h.tasks(order.body.order_id);
      const token = await h.token('staff.store-b');
      const approve = () =>
        h.api('POST', `/api/v1/staff/tasks/${task!.task_id}/approve`, { token, body: { version: task!.version } });
      const results = await Promise.all([approve(), approve()]);
      expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    });

    it('the order is APPROVED only when every node has approved', async () => {
      const order = await h.placeOrder(100);
      const first = await h.act(order.body.order_id, STORE_B, 'approve');
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({ status: 'APPROVED', order_status: 'AWAITING_APPROVAL' });
      const second = await h.act(order.body.order_id, HUB, 'approve');
      expect(second.body).toMatchObject({ status: 'APPROVED', order_status: 'APPROVED' });
    });

    it('refuses forbidden task actions', async () => {
      const order = await h.placeOrder(30);
      const early = await h.act(order.body.order_id, STORE_B, 'dispatch');
      expect(early.status).toBe(409);
      const deliver = await h.act(order.body.order_id, STORE_B, 'deliver', { delivered_qty: 1 });
      expect(deliver.status).toBe(409);
      await h.act(order.body.order_id, STORE_B, 'approve');
      const reject = await h.act(order.body.order_id, STORE_B, 'reject', { reason: 'too late' });
      expect(reject.status).toBe(409);
    });

    it('a split order cannot be dispatched until all nodes approve', async () => {
      const order = await h.placeOrder(100);
      await h.act(order.body.order_id, STORE_B, 'approve');
      const response = await h.act(order.body.order_id, STORE_B, 'dispatch');
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('ORDER_NOT_APPROVED');
    });
  });

  describe('T07: rejection and reallocation', () => {
    it('hub rejects with no other source: hub released, re-plan fails, NEEDS_REVIEW, nothing held', async () => {
      const order = await h.placeOrder(100);
      const response = await h.act(order.body.order_id, HUB, 'reject', { reason: 'Forklift broken' });
      expect(response.status).toBe(200);
      expect(response.body.status).toBe('REJECTED');
      expect(response.body.order_status).toBe('NEEDS_REVIEW');

      const view = await h.api('GET', `/api/v1/orders/${order.body.order_id}`, { token: await h.token('admin.se') });
      const types = view.body.events.map((event: { type: string }) => event.type);
      expect(types).toContain('task.rejected');
      expect(types).toContain('order.needs_reallocation');
      expect(types.lastIndexOf('order.allocating')).toBeGreaterThan(types.indexOf('order.needs_reallocation'));
      expect(view.body.review_reason).toBe('INSUFFICIENT_STOCK');
      expect((await h.stock(HUB)).reserved).toBe(0);
      expect((await h.stock(STORE_B)).reserved).toBe(0);
      expect(await activeReservations(order.body.order_id)).toEqual([]);
    });

    it('re-plans only the missing quantity at a new node, and keeps the rest', async () => {
      const first = await h.placeOrder(100);
      await h.simApi('POST', '/legacy/receipts', { node_id: 'SE-STORE-D', sku_id: CEMENT, qty: 100 });
      await h.sync();
      const response = await h.act(first.body.order_id, HUB, 'reject', { reason: 'No driver' });
      expect(response.body.order_status).toBe('AWAITING_APPROVAL');

      const tasks = await h.tasks(first.body.order_id);
      expect(tasks.map((task) => task.node_id).sort()).toEqual(['SE-STORE-B', 'SE-STORE-D']);
      expect((await h.stock(HUB)).reserved).toBe(0);
      expect((await h.stock(STORE_B)).reserved).toBe(54);
      expect((await h.stock('SE-STORE-D')).reserved).toBe(46);

      await h.pool.query(
        `INSERT INTO users (user_id, password_hash, role, country, store_id) VALUES ('staff.store-d', $1, 'staff', 'SE', 'SE-STORE-D')`,
        [hashPassword(h.config.demoPassword)],
      );
      await h.act(first.body.order_id, STORE_B, 'approve');
      const approved = await h.act(first.body.order_id, 'SE-STORE-D', 'approve');
      expect(approved.body).toMatchObject({ status: 'APPROVED', order_status: 'APPROVED' });

      // The rejecting node is not asked again by later re-planning.
      const view = await h.api('GET', `/api/v1/orders/${first.body.order_id}`, { token: await h.token('admin.se') });
      expect(view.body.allocations.map((a: { node_id: string; quantity: number }) => [a.node_id, a.quantity])).toEqual([
        [STORE_B, 54],
        ['SE-STORE-D', 46],
      ]);
    });

    it('requires a reason', async () => {
      const order = await h.placeOrder(30);
      const [task] = await h.tasks(order.body.order_id);
      const response = await h.api('POST', `/api/v1/staff/tasks/${task!.task_id}/reject`, {
        token: await h.token('staff.store-b'),
        body: { version: task!.version },
      });
      expect(response.status).toBe(400);
    });
  });

  describe('T08: expiry', () => {
    it('an unapproved reservation expires: task and order EXPIRED, stock usable again', async () => {
      h.config.reservation.ttlMinutes = 0.002;
      const order = await h.placeOrder(30);
      expect(order.body.status).toBe('AWAITING_APPROVAL');
      expect((await h.stock(STORE_B)).reserved).toBe(30);

      await new Promise((resolve) => setTimeout(resolve, 200));
      await h.app.container.reservations.tick();

      const view = await h.api('GET', `/api/v1/orders/${order.body.order_id}`, { token: await h.token('buyer.nordbygg') });
      expect(view.body.status).toBe('EXPIRED');
      const { rows } = await h.pool.query('SELECT status FROM fulfilment_tasks WHERE order_id = $1', [order.body.order_id]);
      expect(rows.map((row) => row.status)).toEqual(['EXPIRED']);
      expect((await h.stock(STORE_B)).reserved).toBe(0);

      h.config.reservation.ttlMinutes = 30;
      const next = await h.placeOrder(54);
      expect(next.body.status).toBe('AWAITING_APPROVAL');
      expect(next.body.allocations[0].node_id).toBe(STORE_B);
    });

    it('a late approval of an expired reservation is refused and expires the order', async () => {
      h.config.reservation.ttlMinutes = 0.002;
      const order = await h.placeOrder(30);
      await new Promise((resolve) => setTimeout(resolve, 200));
      const response = await h.act(order.body.order_id, STORE_B, 'approve');
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('RESERVATION_EXPIRED');
      const view = await h.api('GET', `/api/v1/orders/${order.body.order_id}`, { token: await h.token('admin.se') });
      expect(view.body.status).toBe('EXPIRED');
    });

    it('closes a partly approved order at the deadline, including the approved task', async () => {
      h.config.reservation.ttlMinutes = 0.01;
      const order = await h.placeOrder(100);
      expect((await h.act(order.body.order_id, STORE_B, 'approve')).status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 700));
      await h.app.container.reservations.tick();
      const { rows } = await h.pool.query('SELECT status FROM fulfilment_tasks WHERE order_id = $1', [order.body.order_id]);
      expect(rows.map((row) => row.status)).toEqual(['EXPIRED', 'EXPIRED']);
      expect((await h.stock(STORE_B)).reserved).toBe(0);
      expect((await h.stock(HUB)).reserved).toBe(0);
    });
  });

  describe('cancellation', () => {
    it('a customer cancels before approval and all stock goes back', async () => {
      const order = await h.placeOrder(100);
      const response = await h.api('POST', `/api/v1/orders/${order.body.order_id}/cancel`, { token: await h.token('buyer.nordbygg') });
      expect(response.status).toBe(200);
      expect(response.body.status).toBe('CANCELLED');
      expect((await h.stock(STORE_B)).reserved).toBe(0);
      expect((await h.stock(HUB)).reserved).toBe(0);
      const { rows } = await h.pool.query('SELECT status FROM fulfilment_tasks WHERE order_id = $1', [order.body.order_id]);
      expect(rows.every((row) => row.status === 'CANCELLED')).toBe(true);
    });

    it('a NEEDS_REVIEW order can be cancelled, a cancelled one cannot be cancelled again', async () => {
      await h.reset('S2');
      const order = await h.placeOrder(100);
      const token = await h.token('buyer.nordbygg');
      expect((await h.api('POST', `/api/v1/orders/${order.body.order_id}/cancel`, { token })).body.status).toBe('CANCELLED');
      const again = await h.api('POST', `/api/v1/orders/${order.body.order_id}/cancel`, { token });
      expect(again.status).toBe(409);
    });

    it('a stale version on cancel is a 409', async () => {
      const order = await h.placeOrder(5);
      const response = await h.api('POST', `/api/v1/orders/${order.body.order_id}/cancel`, {
        token: await h.token('buyer.nordbygg'),
        body: { version: 1 },
      });
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('VERSION_CONFLICT');
    });

    it('a release that could not get through during an outage is retried afterwards', async () => {
      const order = await h.placeOrder(30);
      await h.outage(true);
      const response = await h.api('POST', `/api/v1/orders/${order.body.order_id}/cancel`, { token: await h.token('buyer.nordbygg') });
      expect(response.body.status).toBe('CANCELLED');
      const { rows } = await h.pool.query(`SELECT count(*)::int AS n FROM reservations WHERE status = 'RELEASING'`);
      expect(rows[0].n).toBe(1);
      await h.outage(false);
      expect((await h.stock(STORE_B)).reserved).toBe(30);
      await h.app.container.reservations.tick();
      expect((await h.stock(STORE_B)).reserved).toBe(0);
    });
  });

  describe('documents', () => {
    it('a picking list has the required fields, decrypted address and the not-a-tax-invoice label', async () => {
      const order = await h.placeOrder(30);
      const [task] = await h.tasks(order.body.order_id);
      const response = await h.api('GET', `/api/v1/staff/tasks/${task!.task_id}/picklist`, { token: await h.token('staff.store-b') });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        document_type: 'picking_list',
        not_a_tax_invoice: true,
        order_id: order.body.order_id,
        task_id: task!.task_id,
        customer_company: 'Nordbygg AB',
        sales_store: { store_id: STORE_B },
        shipping_node: { node_id: STORE_B },
        status: 'PENDING_APPROVAL',
        lines: [{ sku_id: CEMENT, name: 'Portland cement 25 kg bag', quantity: 30, unit: 'bag', unit_price_sek: 89, line_total_sek: 2670 }],
      });
      expect(response.body.site_address).toContain('Askim');
      expect(response.body.eta).toBeTruthy();
    });

    it('an order confirmation exists only once approved and groups the delivery batches', async () => {
      const order = await h.placeOrder(100);
      const token = await h.token('buyer.nordbygg');
      const url = `/api/v1/orders/${order.body.order_id}/confirmation`;
      const early = await h.api('GET', url, { token });
      expect(early.status).toBe(409);
      expect(early.body.error.code).toBe('ORDER_NOT_APPROVED');

      await h.act(order.body.order_id, STORE_B, 'approve');
      await h.act(order.body.order_id, HUB, 'approve');
      const response = await h.api('GET', url, { token });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ document_type: 'order_confirmation', not_a_tax_invoice: true, customer_company: 'Nordbygg AB' });
      expect(response.body.shipments).toHaveLength(2);
      expect(response.body.shipments[0].approver).toBe('staff.store-b');
      expect(response.body.shipments[0].approved_at).toBeTruthy();
      expect(response.body.shipments[1].lines[0].quantity).toBe(46);
    });
  });

  describe('crash recovery', () => {
    it('closes an allocation stopped by a crash and frees what it held', async () => {
      const order = await h.placeOrder(30);
      // As if the process died while allocating.
      await h.pool.query(`UPDATE orders SET status = 'ALLOCATING', updated_at = now() - interval '10 minutes' WHERE order_id = $1`, [
        order.body.order_id,
      ]);
      await h.pool.query(`UPDATE fulfilment_tasks SET status = 'CANCELLED' WHERE order_id = $1`, [order.body.order_id]);
      await h.app.container.allocation.recoverInterrupted();
      const view = await h.api('GET', `/api/v1/orders/${order.body.order_id}`, { token: await h.token('admin.se') });
      expect(view.body).toMatchObject({ status: 'NEEDS_REVIEW', review_reason: 'ALLOCATION_INTERRUPTED' });
      expect((await h.stock(STORE_B)).reserved).toBe(0);
    });

    it('a retry after a crash returns the order as it stands', async () => {
      const key = randomUUID();
      const order = await h.placeOrder(5, { key });
      const { rows } = await h.pool.query(`SELECT key FROM idempotency_records`);
      expect(rows[0].key).toBe(key);
      await h.pool.query(
        `UPDATE idempotency_records SET status_code = NULL, response = NULL, created_at = now() - interval '10 minutes'`,
      );
      const replay = await h.placeOrder(5, { key });
      expect(replay.status).toBe(201);
      expect(replay.body.order_id).toBe(order.body.order_id);
    });
  });

  it('source reservations match the ones Local SE tracks', async () => {
    await h.placeOrder(100);
    expect(await sourceReservations(STORE_B)).toEqual([{ qty: 54 }]);
    expect(await sourceReservations(HUB)).toEqual([{ qty: 46 }]);
  });
});
