import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HUB, startHarness, STORE_B, type Harness } from './harness.js';

const STORE_C = 'SE-STORE-C';
const PLASTERBOARD = 'SE-GYP-13-2400';

describe('Round 1 circuit breaker: a node that stops reporting is isolated', () => {
  let h: Harness;

  const link = (node: string, up: boolean) => h.simApi('POST', `/legacy/admin/stores/${node}/link`, { up });
  /** Takes the node down, lets more than the timeout pass, and runs the worker once. */
  const silence = async (node: string) => {
    await link(node, false);
    await new Promise((resolve) => setTimeout(resolve, 1300));
    return h.app.container.nodes.tick();
  };
  const allocations = async (orderId: string) =>
    (
      await h.api('GET', `/api/v1/orders/${orderId}`, { token: await h.token('admin.se') })
    ).body.allocations.map((allocation: { node_id: string; quantity: number }) => [allocation.node_id, allocation.quantity]);

  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.reset('S1');
    h.config.nodes.heartbeatTimeoutSeconds = 1;
    await h.app.container.nodes.tick();
  });

  it('keeps every node in routing while their servers report', async () => {
    expect(await h.app.container.nodes.tick()).toBe(0);
    const order = await h.placeOrder(30);
    expect(await allocations(order.body.order_id)).toEqual([[STORE_B, 30]]);
  });

  it('routes a new order around a silent node', async () => {
    await silence(STORE_B);
    const order = await h.placeOrder(30);
    expect(order.body.status).toBe('AWAITING_APPROVAL');
    expect(await allocations(order.body.order_id)).toEqual([[HUB, 30]]);
    expect((await h.stock(STORE_B)).reserved).toBe(0);
  });

  it('moves a part still waiting for approval to the next node, releasing the silent one', async () => {
    const order = await h.placeOrder(30);
    expect(await allocations(order.body.order_id)).toEqual([[STORE_B, 30]]);

    expect(await silence(STORE_B)).toBe(1);
    const view = await h.api('GET', `/api/v1/orders/${order.body.order_id}`, { token: await h.token('admin.se') });
    expect(view.body.status).toBe('AWAITING_APPROVAL');
    expect(await allocations(order.body.order_id)).toEqual([[HUB, 30]]);
    expect((await h.tasks(order.body.order_id)).map((task) => task.node_id)).toEqual([HUB]);
    expect((await h.stock(STORE_B)).reserved).toBe(0);
    expect((await h.stock(HUB)).reserved).toBe(30);

    // The move is recorded as the system's doing, and Central learns why without any free text.
    const event = await h.pool.query(
      `SELECT actor, data FROM order_events WHERE order_id = $1 AND type = 'task.rejected'`,
      [order.body.order_id],
    );
    expect(event.rows[0]).toMatchObject({ actor: 'system', data: { node_id: STORE_B } });
    const outbox = await h.pool.query(
      `SELECT payload FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'task.rejected.v1'`,
      [order.body.order_id],
    );
    expect(outbox.rows[0].payload).toMatchObject({ node_id: STORE_B, task_status: 'REJECTED', reason: 'NODE_OFFLINE' });

    // A second tick finds nothing more to move.
    expect(await h.app.container.nodes.tick()).toBe(0);
  });

  it('splits across the remaining nodes when the silent node held part of a split order', async () => {
    const order = await h.placeOrder(100, { sku: PLASTERBOARD, unit: 'sheet' });
    const [first] = await allocations(order.body.order_id);
    expect(await silence(first[0])).toBe(1);
    const after = await allocations(order.body.order_id);
    expect(after.map(([node]: [string]) => node)).not.toContain(first[0]);
    expect(after.reduce((sum: number, [, quantity]: [string, number]) => sum + quantity, 0)).toBe(100);
  });

  it('leaves an approved part alone: the stock is already promised by people at that node', async () => {
    const order = await h.placeOrder(30);
    await h.act(order.body.order_id, STORE_B, 'approve');
    expect(await silence(STORE_B)).toBe(0);
    expect((await h.tasks(order.body.order_id))[0]).toMatchObject({ node_id: STORE_B, status: 'APPROVED' });
  });

  it('sends the order for review when no other node can cover it', async () => {
    const order = await h.placeOrder(100);
    expect(await allocations(order.body.order_id)).toEqual([
      [STORE_B, 54],
      [HUB, 46],
    ]);
    expect(await silence(HUB)).toBe(1);
    const view = await h.api('GET', `/api/v1/orders/${order.body.order_id}`, { token: await h.token('admin.se') });
    expect(view.body).toMatchObject({ status: 'NEEDS_REVIEW', review_reason: 'INSUFFICIENT_STOCK' });
    expect((await h.stock(STORE_B)).reserved).toBe(0);
    expect((await h.stock(HUB)).reserved).toBe(0);
  });

  it('brings the node back as soon as its server reports again', async () => {
    await silence(STORE_B);
    await link(STORE_B, true);
    await h.app.container.nodes.tick();
    const order = await h.placeOrder(30);
    expect(await allocations(order.body.order_id)).toEqual([[STORE_B, 30]]);
  });

  it('does not take a node offline because the source itself could not be read', async () => {
    await h.outage(true);
    await new Promise((resolve) => setTimeout(resolve, 1300));
    expect(await h.app.container.nodes.tick()).toBe(0);
    await h.outage(false);
    const { rows } = await h.pool.query(
      `SELECT count(*)::int AS offline FROM stores WHERE heartbeat_checked_at - last_heartbeat_at > interval '1 second'`,
    );
    expect(rows[0].offline).toBe(0);
    const order = await h.placeOrder(30);
    expect(await allocations(order.body.order_id)).toEqual([[STORE_B, 30]]);
  });

  it('shows the isolated node on the operations metrics', async () => {
    await silence(STORE_C);
    const metrics = await h.api('GET', '/api/v1/metrics', { token: await h.token('admin.se') });
    const nodes = metrics.body.inventory.nodes as { node_id: string; offline: boolean }[];
    expect(nodes.find((node) => node.node_id === STORE_C)?.offline).toBe(true);
    expect(nodes.find((node) => node.node_id === STORE_B)?.offline).toBe(false);
  });
});
