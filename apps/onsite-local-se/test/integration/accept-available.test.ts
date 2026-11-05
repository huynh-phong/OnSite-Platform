import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CEMENT, HUB, NEAR_SITE, startHarness, STORE_B, type Harness } from './harness.js';

describe('Accepting what can be supplied now, for an order that was short', () => {
  let h: Harness;

  const accept = async (orderId: string, version: number, user = 'buyer.nordbygg') =>
    h.api('POST', `/api/v1/orders/${orderId}/accept-available`, { token: await h.token(user), body: { version } });

  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.reset('S2');
  });

  it('S2: accepting 90 of 100 reserves 54 + 36, keeps the 100 asked for, and goes to approval', async () => {
    const order = await h.placeOrder(100);
    expect(order.body).toMatchObject({ status: 'NEEDS_REVIEW', review_reason: 'INSUFFICIENT_STOCK', fulfillable_qty: 90 });

    const response = await accept(order.body.order_id, order.body.version);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: 'AWAITING_APPROVAL',
      review_reason: null,
      fulfillable_qty: null,
      early_shortage_detected: true,
      items: [{ sku_id: CEMENT, quantity: 90, requested_quantity: 100 }],
    });
    expect(response.body.allocations.map((a: { node_id: string; quantity: number }) => [a.node_id, a.quantity])).toEqual([
      [STORE_B, 54],
      [HUB, 36],
    ]);
    expect((await h.stock(STORE_B)).reserved).toBe(54);
    expect((await h.stock(HUB)).reserved).toBe(36);
    const types = response.body.events.map((event: { type: string }) => event.type);
    const accepted = types.indexOf('order.available_accepted');
    expect(accepted).toBeGreaterThan(types.indexOf('order.needs_review'));
    expect(types.slice(accepted, accepted + 2)).toEqual(['order.available_accepted', 'order.allocating']);
    expect(types.at(-1)).toBe('order.awaiting_approval');

    // The rest of the journey is unchanged, and in-full is judged against the 90 agreed.
    for (const node of [STORE_B, HUB]) await h.act(order.body.order_id, node, 'approve');
    for (const node of [STORE_B, HUB]) await h.act(order.body.order_id, node, 'dispatch');
    await h.act(order.body.order_id, STORE_B, 'deliver', { delivered_qty: 54 });
    const done = await h.act(order.body.order_id, HUB, 'deliver', { delivered_qty: 36 });
    expect(done.body.order_status).toBe('DELIVERED');
    const view = await h.api('GET', `/api/v1/orders/${order.body.order_id}`, { token: await h.token('buyer.nordbygg') });
    expect(view.body.otif).toBe(true);
  });

  it('uses the stock available at the time of accepting, not the old figure', async () => {
    const order = await h.placeOrder(100);
    await h.simApi('POST', '/legacy/receipts', { node_id: HUB, sku_id: CEMENT, qty: 20 });
    await h.sync();
    const response = await accept(order.body.order_id, order.body.version);
    expect(response.body).toMatchObject({ status: 'AWAITING_APPROVAL', items: [{ quantity: 100, requested_quantity: null }] });
  });

  it('refuses a stale version, staff, and an order that is not short', async () => {
    const order = await h.placeOrder(100);
    expect((await accept(order.body.order_id, order.body.version - 1)).body.error.code).toBe('VERSION_CONFLICT');
    expect((await accept(order.body.order_id, order.body.version, 'staff.store-b')).status).toBe(403);

    await h.reset('S2');
    const fine = await h.placeOrder(30);
    expect(fine.body.status).toBe('AWAITING_APPROVAL');
    const refused = await accept(fine.body.order_id, fine.body.version);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('INVALID_TRANSITION');
    expect((await h.stock(STORE_B)).reserved).toBe(30);
  });

  it('refuses an order that is under review for a source problem, not a shortage', async () => {
    await h.outage(true);
    const order = await h.placeOrder(30);
    await h.outage(false);
    expect(order.body.review_reason).toBe('SOURCE_UNAVAILABLE');
    const refused = await accept(order.body.order_id, order.body.version);
    expect(refused.body.error.code).toBe('INVALID_TRANSITION');
  });

  it('refuses when nothing can be supplied, and changes nothing', async () => {
    const order = await h.placeOrder(100);
    // Everything else is sold before the customer decides.
    for (const [node, qty] of [
      [STORE_B, 60],
      [HUB, 40],
    ] as const) {
      await h.simPool.query(`UPDATE inventory SET on_hand = on_hand - $3 WHERE node_id = $1 AND sku_id = $2`, [node, CEMENT, qty]);
      await h.simPool.query(`INSERT INTO change_feed (entity, entity_id) VALUES ('inventory', $1)`, [`${node}:${CEMENT}`]);
    }
    await h.sync();
    const refused = await accept(order.body.order_id, order.body.version);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('NOTHING_AVAILABLE');
    const view = await h.api('GET', `/api/v1/orders/${order.body.order_id}`, { token: await h.token('buyer.nordbygg') });
    expect(view.body).toMatchObject({ status: 'NEEDS_REVIEW', items: [{ quantity: 100, requested_quantity: null }] });
  });

  it('refuses to drop a line that has nothing available, and asks for a new order instead', async () => {
    const response = await h.api('POST', '/api/v1/orders', {
      token: await h.token('buyer.nordbygg'),
      headers: { 'idempotency-key': randomUUID() },
      body: {
        sales_store_id: STORE_B,
        site_id: NEAR_SITE,
        requested_delivery_at: new Date(Date.now() + 7 * 86400_000).toISOString(),
        items: [
          { sku_id: CEMENT, quantity: 100, unit: 'bag' },
          { sku_id: 'SE-GYP-13-2400', quantity: 5, unit: 'sheet' },
        ],
      },
    });
    expect(response.body.status).toBe('NEEDS_REVIEW');
    await h.simPool.query(`UPDATE inventory SET on_hand = 0 WHERE sku_id = $1`, [CEMENT]);
    await h.simPool.query(
      `INSERT INTO change_feed (entity, entity_id) SELECT 'inventory', node_id || ':' || sku_id FROM inventory WHERE sku_id = $1`,
      [CEMENT],
    );
    await h.sync();
    const refused = await accept(response.body.order_id, response.body.version);
    expect(refused.body.error).toMatchObject({ code: 'LINE_UNAVAILABLE' });
    expect(refused.body.error.message).toContain(CEMENT);
  });
});
