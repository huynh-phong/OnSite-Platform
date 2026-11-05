import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CEMENT, FAR_SITE, HUB, startHarness, STORE_B, type Harness } from './harness.js';

describe('Checkpoint 4: fulfilment and reliability', () => {
  let h: Harness;

  const fullFlow = async (quantity = 100, requestedAt?: string) => {
    const order = await h.placeOrder(quantity, requestedAt ? { requestedAt } : {});
    const orderId = order.body.order_id as string;
    await h.act(orderId, STORE_B, 'approve');
    await h.act(orderId, HUB, 'approve');
    await h.act(orderId, STORE_B, 'dispatch');
    await h.act(orderId, HUB, 'dispatch');
    return orderId;
  };
  const view = async (orderId: string, user = 'admin.se') =>
    (await h.api('GET', `/api/v1/orders/${orderId}`, { token: await h.token(user) })).body;

  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.reset('S1');
  });

  describe('T09: approve, dispatch, deliver', () => {
    it('goes all the way to DELIVERED with OUTBOUND ledger rows and OTIF', async () => {
      const order = await h.placeOrder(100);
      const orderId = order.body.order_id;

      expect((await h.act(orderId, STORE_B, 'approve')).body.order_status).toBe('AWAITING_APPROVAL');
      expect((await h.act(orderId, HUB, 'approve')).body.order_status).toBe('APPROVED');
      expect((await h.act(orderId, STORE_B, 'dispatch')).body.order_status).toBe('DISPATCHING');
      expect((await h.act(orderId, HUB, 'dispatch')).body.order_status).toBe('DISPATCHED');

      const ledger = await h.simApi('GET', `/legacy/transactions?sku_id=${CEMENT}&limit=1000`);
      const outbound = ledger.body.filter((row: { type: string }) => row.type === 'OUTBOUND');
      expect(outbound.map((row: { node_id: string; qty: number }) => [row.node_id, row.qty]).sort()).toEqual([
        [HUB, 46],
        [STORE_B, 54],
      ]);
      expect(await h.stock(STORE_B)).toEqual({ on_hand: 6, reserved: 0 });
      expect(await h.stock(HUB)).toEqual({ on_hand: 14, reserved: 0 });

      expect((await h.act(orderId, STORE_B, 'deliver', { delivered_qty: 54, note: 'Left at gate' })).body.status).toBe('DELIVERED');
      const done = await h.act(orderId, HUB, 'deliver', { delivered_qty: 46 });
      expect(done.body.order_status).toBe('DELIVERED');

      const final = await view(orderId, 'buyer.nordbygg');
      expect(final).toMatchObject({ status: 'DELIVERED', otif: true });
      expect(final.delivered_at).toBeTruthy();

      const metrics = await h.api('GET', '/api/v1/metrics', { token: await h.token('admin.se') });
      expect(metrics.body.business).toMatchObject({ delivered_orders: 1, otif_rate: 1, simulated_data: true });
    });

    it('a short delivery marks the shipment short and fails OTIF', async () => {
      const orderId = await fullFlow();
      await h.act(orderId, STORE_B, 'deliver', { delivered_qty: 50 });
      await h.act(orderId, HUB, 'deliver', { delivered_qty: 46 });
      const final = await view(orderId);
      expect(final.otif).toBe(false);
      const b = final.shipments.find((s: { node_id: string }) => s.node_id === STORE_B);
      const hub = final.shipments.find((s: { node_id: string }) => s.node_id === HUB);
      expect(b).toMatchObject({ is_short: true, delivered_qty: 50 });
      expect(hub.is_short).toBe(false);
    });

    it('a late delivery fails OTIF', async () => {
      const orderId = await fullFlow(100, new Date(Date.now() - 60_000).toISOString());
      await h.act(orderId, STORE_B, 'deliver', { delivered_qty: 54 });
      await h.act(orderId, HUB, 'deliver', { delivered_qty: 46 });
      expect((await view(orderId)).otif).toBe(false);
      const metrics = await h.api('GET', '/api/v1/metrics', { token: await h.token('admin.se') });
      expect(metrics.body.business.otif_rate).toBe(0);
    });

    it('refuses to deliver more than allocated', async () => {
      const orderId = await fullFlow();
      const response = await h.act(orderId, STORE_B, 'deliver', { delivered_qty: 55 });
      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('INVALID_QUANTITY');
    });

    it('order is DELIVERED only when every shipment is', async () => {
      const orderId = await fullFlow();
      expect((await h.act(orderId, STORE_B, 'deliver', { delivered_qty: 54 })).body.order_status).toBe('DISPATCHED');
    });

    it('a node can deliver before the other dispatches, and the order still finishes correctly', async () => {
      const order = await h.placeOrder(100);
      const orderId = order.body.order_id;
      await h.act(orderId, STORE_B, 'approve');
      await h.act(orderId, HUB, 'approve');
      await h.act(orderId, STORE_B, 'dispatch');
      expect((await h.act(orderId, STORE_B, 'deliver', { delivered_qty: 54 })).body.order_status).toBe('DISPATCHING');
      expect((await h.act(orderId, HUB, 'dispatch')).body.order_status).toBe('DISPATCHED');
      expect((await h.act(orderId, HUB, 'deliver', { delivered_qty: 46 })).body.order_status).toBe('DELIVERED');
    });

    it('a dispatch after a transient source failure succeeds on retry, committing once', async () => {
      const order = await h.placeOrder(30);
      const orderId = order.body.order_id;
      await h.act(orderId, STORE_B, 'approve');
      await h.outage(true);
      expect((await h.act(orderId, STORE_B, 'dispatch')).status).toBe(503);
      await h.outage(false);
      expect((await h.act(orderId, STORE_B, 'dispatch')).body.status).toBe('DISPATCHED');
      expect(await h.stock(STORE_B)).toEqual({ on_hand: 30, reserved: 0 });
    });
  });

  describe('T10: ETA and AT_RISK', () => {
    it('a far site with an early deadline is at risk, with an event in the outbox', async () => {
      const response = await h.placeOrder(10, {
        site: FAR_SITE,
        requestedAt: new Date(Date.now() + 60_000).toISOString(),
      });
      expect(response.body).toMatchObject({ status: 'AWAITING_APPROVAL', at_risk: true });
      expect(response.body.at_risk_reason).toContain('after the requested time');
      expect(response.body.eta_is_estimate).toBe(true);

      const outbox = await h.pool.query(`SELECT * FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'order.at_risk.v1'`, [
        response.body.order_id,
      ]);
      expect(outbox.rows).toHaveLength(1);
      const history = response.body.events.map((event: { type: string }) => event.type);
      expect(history).toContain('order.at_risk');
    });

    it('a normal order is not at risk and shows a provisional ETA before approval', async () => {
      const response = await h.placeOrder(10);
      expect(response.body.at_risk).toBe(false);
      expect(response.body.shipments[0].eta_inputs).toMatchObject({ provisional: true, prep_minutes: 60, avg_speed_kmh: 40 });
    });

    it('the ETA becomes firm on approval, using the node\'s approval time', async () => {
      const order = await h.placeOrder(10);
      await h.act(order.body.order_id, STORE_B, 'approve');
      const after = await view(order.body.order_id);
      expect(after.shipments[0].eta_inputs.provisional).toBe(false);
      expect(after.shipments[0].dispatch_slot).toBeTruthy();
    });

    it('the worker flags an order that time has made late, once, and clears when it no longer is', async () => {
      const order = await h.placeOrder(10);
      const orderId = order.body.order_id;
      const { rows } = await h.pool.query('SELECT eta FROM orders WHERE order_id = $1', [orderId]);
      await h.pool.query('UPDATE orders SET requested_delivery_at = $2 WHERE order_id = $1', [
        orderId,
        new Date(rows[0].eta.getTime() - 60_000),
      ]);
      await h.app.container.eta.tick();
      await h.app.container.eta.tick();
      const late = await view(orderId);
      expect(late.at_risk).toBe(true);
      expect(late.events.filter((event: { type: string }) => event.type === 'order.at_risk')).toHaveLength(1);

      await h.pool.query('UPDATE orders SET requested_delivery_at = $2 WHERE order_id = $1', [
        orderId,
        new Date(Date.now() + 30 * 86400_000),
      ]);
      await h.app.container.eta.tick();
      const cleared = await view(orderId);
      expect(cleared.at_risk).toBe(false);
      expect(cleared.events.map((event: { type: string }) => event.type)).toContain('order.at_risk_cleared');
      expect((await h.api('GET', '/api/v1/metrics', { token: await h.token('admin.se') })).body.business.at_risk_alerts_sent).toBe(1);
    });
  });

  describe('T15: simulator outage', () => {
    it('stock is STALE, new orders go to NEEDS_REVIEW (SOURCE_UNAVAILABLE), and it recovers without a restart', async () => {
      await h.outage(true);
      expect((await h.sync()).ok).toBe(false);
      const stale = await h.app.container.inventory.freshness();
      expect(stale.trusted).toBe(false);

      const order = await h.placeOrder(30);
      expect(order.status).toBe(201);
      expect(order.body).toMatchObject({ status: 'NEEDS_REVIEW', review_reason: 'SOURCE_UNAVAILABLE' });
      expect(order.body.allocations).toEqual([]);

      const list = await h.api('GET', '/api/v1/orders', { token: await h.token('buyer.nordbygg') });
      expect(list.status).toBe(200);

      await h.outage(false);
      expect((await h.sync()).ok).toBe(true);
      const next = await h.placeOrder(30);
      expect(next.body.status).toBe('AWAITING_APPROVAL');
    });

    it('existing work is unaffected: a refused approval leaves it to retry', async () => {
      const order = await h.placeOrder(30);
      await h.outage(true);
      expect((await h.act(order.body.order_id, STORE_B, 'approve')).status).toBe(503);
      await h.outage(false);
      expect((await h.act(order.body.order_id, STORE_B, 'approve')).status).toBe(200);
    });
  });

  describe('T16: every change has an order event and an outbox row', () => {
    const PII = /Nordbygg|Askim|Skövde|Demo Site|site\.manager|\+46|Forklift|Left at gate/i;

    it('matches events to outbox rows one to one, in one flow with every kind of change', async () => {
      // A delivered order with a note.
      const orderId = await fullFlow();
      await h.act(orderId, STORE_B, 'deliver', { delivered_qty: 54, note: 'Left at gate' });
      await h.act(orderId, HUB, 'deliver', { delivered_qty: 46 });
      // Rejected with a free-text reason, then shortage.
      const second = await h.placeOrder(4);
      await h.act(second.body.order_id, STORE_B, 'reject', { reason: 'Forklift broken' });
      // Cancelled.
      const third = await h.placeOrder(2);
      await h.api('POST', `/api/v1/orders/${third.body.order_id}/cancel`, { token: await h.token('buyer.nordbygg') });
      // At risk.
      await h.placeOrder(1, { site: FAR_SITE, requestedAt: new Date(Date.now() + 1000).toISOString() });

      const events = await h.pool.query('SELECT order_id, version, type FROM order_events ORDER BY order_event_id');
      const outbox = await h.pool.query(
        'SELECT aggregate_id, aggregate_version, event_type, payload, status, event_id FROM outbox_events ORDER BY outbox_id',
      );
      expect(events.rows.length).toBeGreaterThan(20);
      expect(outbox.rows.length).toBe(events.rows.length);
      for (const event of events.rows) {
        const match = outbox.rows.filter(
          (row) =>
            row.aggregate_id === event.order_id &&
            row.aggregate_version === event.version &&
            row.event_type === `${event.type}.v1`,
        );
        expect(match, `${event.order_id} v${event.version} ${event.type}`).toHaveLength(1);
      }
      for (const row of outbox.rows) {
        expect(JSON.stringify(row.payload)).not.toMatch(PII);
        expect(row.payload).not.toHaveProperty('site_id');
        expect(row.payload).not.toHaveProperty('customer_id');
        expect(row.status).toBe('PENDING');
      }
      expect(new Set(outbox.rows.map((row) => row.event_id)).size).toBe(outbox.rows.length);
      // Versions of one order only go up.
      const versions = events.rows.filter((row) => row.order_id === orderId).map((row) => row.version);
      expect(versions).toEqual([...versions].sort((a, b) => a - b));
      expect(new Set(versions).size).toBe(versions.length);
    });

    it('order events cannot be changed afterwards', async () => {
      await h.placeOrder(1);
      await expect(h.pool.query(`UPDATE order_events SET type = 'x'`)).rejects.toThrow(/append-only/);
      await expect(h.pool.query(`DELETE FROM order_events`)).rejects.toThrow(/append-only/);
    });

    it('an event is rolled back with its business change', async () => {
      const order = await h.placeOrder(5);
      const before = await h.pool.query('SELECT count(*) FROM outbox_events');
      const [task] = await h.tasks(order.body.order_id);
      const token = await h.token('staff.store-b');
      await h.api('POST', `/api/v1/staff/tasks/${task!.task_id}/approve`, { token, body: { version: 999 } });
      const after = await h.pool.query('SELECT count(*) FROM outbox_events');
      expect(after.rows[0].count).toBe(before.rows[0].count);
    });
  });

  describe('outbox sender', () => {
    let central: Server;
    let received: { event_id: string; event_type: string; payload: unknown }[] = [];
    let respond = 200;

    beforeAll(async () => {
      central = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => {
          if (respond < 300) received.push(JSON.parse(Buffer.concat(chunks).toString()));
          response.statusCode = respond;
          response.end();
        });
      });
      await new Promise<void>((resolve) => central.listen(0, '127.0.0.1', resolve));
    });
    afterAll(async () => {
      await new Promise((resolve) => central.close(resolve));
    });
    beforeEach(() => {
      received = [];
      respond = 200;
      h.config.centralIngestUrl = `http://127.0.0.1:${(central.address() as AddressInfo).port}/ingest/events`;
    });
    const dueNow = () => h.pool.query(`UPDATE outbox_events SET next_attempt_at = now() WHERE status = 'PENDING'`);
    const statuses = async () =>
      (await h.pool.query('SELECT status, count(*)::int AS n FROM outbox_events GROUP BY status')).rows.reduce(
        (all, row) => ({ ...all, [row.status]: row.n }),
        {},
      );

    it('with no Central configured, events stay pending, the metrics say so, and Local keeps working', async () => {
      h.config.centralIngestUrl = undefined;
      await h.placeOrder(5);
      expect(await h.app.container.outbox.tick()).toBe(0);
      const metrics = await h.api('GET', '/api/v1/metrics', { token: await h.token('admin.se') });
      expect(metrics.body.outbox.outbox_pending).toBeGreaterThan(0);
      expect(metrics.body.outbox.outbox_oldest_age_s).toBeGreaterThanOrEqual(0);
      expect(metrics.body.outbox.outbox_delivered).toBe(0);
    });

    it('delivers events with the agreed fields, marking them delivered', async () => {
      await h.placeOrder(5);
      const pending = (await statuses()).PENDING;
      expect(await h.app.container.outbox.tick()).toBe(pending);
      expect(await statuses()).toEqual({ DELIVERED: pending });
      expect(received[0]).toMatchObject({ origin_country: 'SE', aggregate_type: 'order', event_type: 'order.submitted.v1' });
      expect(await h.app.container.outbox.tick()).toBe(0);
    });

    it('retries while Central is down, with nothing lost, then catches up', async () => {
      await h.placeOrder(5);
      const pending = (await statuses()).PENDING;
      respond = 503;
      expect(await h.app.container.outbox.tick()).toBe(0);
      expect(await statuses()).toEqual({ PENDING: pending });
      const row = await h.pool.query('SELECT retry_count, non_retryable_failures, next_attempt_at FROM outbox_events LIMIT 1');
      expect(row.rows[0].retry_count).toBe(1);
      expect(row.rows[0].non_retryable_failures).toBe(0);

      respond = 200;
      await dueNow();
      expect(await h.app.container.outbox.tick()).toBe(pending);
      expect(await statuses()).toEqual({ DELIVERED: pending });
    });

    it('does not retry before the backoff, so a claimed event is not sent twice', async () => {
      await h.placeOrder(5);
      const results = await Promise.all([h.app.container.outbox.tick(), h.app.container.outbox.tick()]);
      const pending = (await statuses()).DELIVERED;
      expect(results[0] + results[1]).toBe(pending);
      expect(new Set(received.map((event) => event.event_id)).size).toBe(received.length);
    });

    it('marks an event DEAD only after 10 refusals, without blocking the others', async () => {
      await h.placeOrder(5);
      const total = (await statuses()).PENDING;
      respond = 422;
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await dueNow();
        await h.app.container.outbox.tick();
      }
      expect(await statuses()).toEqual({ DEAD: total });
      const metrics = await h.api('GET', '/api/v1/metrics', { token: await h.token('admin.se') });
      expect(metrics.body.outbox.outbox_dead).toBe(total);
      respond = 200;
      await h.placeOrder(1);
      expect((await h.app.container.outbox.tick()) > 0).toBe(true);
    });

    it('a network failure counts as retryable, never as a refusal', async () => {
      h.config.centralIngestUrl = 'http://127.0.0.1:9/unreachable';
      await h.placeOrder(5);
      await h.app.container.outbox.tick();
      const { rows } = await h.pool.query(`SELECT DISTINCT status, non_retryable_failures FROM outbox_events`);
      expect(rows).toEqual([{ status: 'PENDING', non_retryable_failures: 0 }]);
    });

    it('sets next attempt with a growing backoff', async () => {
      await h.placeOrder(1);
      respond = 500;
      await h.app.container.outbox.tick();
      const { rows } = await h.pool.query(`SELECT retry_count, next_attempt_at FROM outbox_events`);
      for (const row of rows) {
        expect(row.retry_count).toBe(1);
        expect(row.next_attempt_at.getTime()).toBeLessThan(Date.now() + 5000);
      }
    });
  });

  describe('SSE', () => {
    let baseUrl: string;
    const openStream = async (query: string, init: RequestInit = {}) => {
      const controller = new AbortController();
      const response = await fetch(`${baseUrl}/api/v1/stream${query}`, { ...init, signal: controller.signal });
      const events: { event: string; data: Record<string, unknown> }[] = [];
      let text = '';
      const pump = (async () => {
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          text += decoder.decode(value);
          const blocks = text.split('\n\n');
          text = blocks.pop()!;
          for (const block of blocks) {
            const event = /^event: (.+)$/m.exec(block)?.[1];
            const data = /^data: (.+)$/m.exec(block)?.[1];
            if (event && data) events.push({ event, data: JSON.parse(data) });
          }
        }
      })().catch(() => undefined);
      return {
        response,
        events,
        close: async () => {
          controller.abort();
          await pump;
        },
      };
    };
    const until = async (check: () => boolean) => {
      for (let i = 0; i < 100 && !check(); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    };

    beforeAll(async () => {
      const address = await h.app.listen({ host: '127.0.0.1', port: 0 });
      baseUrl = address;
    });

    it('refuses a missing or bad token', async () => {
      expect((await fetch(`${baseUrl}/api/v1/stream`)).status).toBe(401);
      expect((await fetch(`${baseUrl}/api/v1/stream?token=bad`)).status).toBe(401);
    });

    it('scopes events: staff get their node, customers their orders', async () => {
      const staffB = await openStream(`?token=${await h.token('staff.store-b')}`);
      const staffC = await openStream('', { headers: { authorization: `Bearer ${await h.token('staff.store-c')}` } });
      const buyer = await openStream(`?token=${await h.token('buyer.nordbygg')}`);
      const admin = await openStream(`?token=${await h.token('admin.se')}`);
      expect(staffB.response.headers.get('content-type')).toContain('text/event-stream');

      const order = await h.placeOrder(10);
      const orderId = order.body.order_id;
      await until(() => staffB.events.some((e) => e.event === 'task.assigned'));

      expect(staffB.events.find((e) => e.event === 'task.assigned')!.data.order_id).toBe(orderId);
      expect(staffC.events).toEqual([]);
      expect(admin.events.some((e) => e.event === 'task.assigned')).toBe(true);
      expect(buyer.events.some((e) => e.event === 'task.assigned')).toBe(false);
      expect(buyer.events.some((e) => e.event === 'order.updated')).toBe(true);

      await h.act(orderId, STORE_B, 'approve');
      await until(() => staffB.events.some((e) => e.event === 'task.updated'));
      expect(staffB.events.some((e) => e.event === 'task.updated')).toBe(true);

      for (const stream of [staffB, staffC, buyer, admin]) await stream.close();
    });

    it('carries at-risk alerts and new reviews', async () => {
      const buyer = await openStream(`?token=${await h.token('buyer.nordbygg')}`);
      const staff = await openStream(`?token=${await h.token('staff.store-b')}`);
      await h.placeOrder(5, { site: FAR_SITE, requestedAt: new Date(Date.now() + 1000).toISOString() });
      await until(() => buyer.events.some((e) => e.event === 'order.at_risk'));
      expect(buyer.events.some((e) => e.event === 'order.at_risk')).toBe(true);

      await h.simApi('POST', '/legacy/products', {
        sku_id: 'SE-SSE-1',
        name: 'SSE',
        source_unit: 'flarp',
        source_category: 'cement',
        source_description: 'No weight here',
        unit_price_sek: 1,
      });
      await h.sync();
      await until(() => staff.events.some((e) => e.event === 'review.created'));
      expect(staff.events.some((e) => e.event === 'review.created')).toBe(true);
      expect(buyer.events.some((e) => e.event === 'review.created')).toBe(false);
      await buyer.close();
      await staff.close();
    });

    it('does not send a notification for a change that failed', async () => {
      const staff = await openStream(`?token=${await h.token('staff.store-b')}`);
      const order = await h.placeOrder(5);
      await until(() => staff.events.length > 1);
      const count = staff.events.length;
      const [task] = await h.tasks(order.body.order_id);
      await h.api('POST', `/api/v1/staff/tasks/${task!.task_id}/approve`, {
        token: await h.token('staff.store-b'),
        body: { version: 999 },
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(staff.events.length).toBe(count);
      await staff.close();
    });
  });
});
