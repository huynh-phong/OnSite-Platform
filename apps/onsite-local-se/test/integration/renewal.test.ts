import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SourceUnavailableError } from '../../src/connectors/simulator.js';
import { HUB, startHarness, STORE_B, type Harness } from './harness.js';

describe('Issue 1: reservation renewal after approval', () => {
  let h: Harness;

  const renew = () => h.app.container.reservations.renewDue();
  const localReservations = async (orderId: string) =>
    (
      await h.pool.query(
        `SELECT r.*, a.node_id FROM reservations r JOIN allocations a USING (allocation_id) JOIN order_items i USING (item_id)
          WHERE i.order_id = $1 ORDER BY a.node_id`,
        [orderId],
      )
    ).rows;
  /** Moves both sides' clocks, as if this much time had passed since the last renewal. */
  const leaveMinutes = async (orderId: string, minutes: number, node?: string) => {
    const rows = (await localReservations(orderId)).filter((row) => !node || row.node_id === node);
    for (const row of rows) {
      await h.pool.query(`UPDATE reservations SET expires_at = now() + make_interval(secs => $2) WHERE reservation_id = $1`, [
        row.reservation_id,
        minutes * 60,
      ]);
      await h.simPool.query(`UPDATE reservations SET expires_at = now() + make_interval(secs => $2) WHERE id = $1`, [
        row.external_ref,
        minutes * 60,
      ]);
    }
  };
  const approved = async () => {
    const order = await h.placeOrder(100);
    await h.act(order.body.order_id, STORE_B, 'approve');
    await h.act(order.body.order_id, HUB, 'approve');
    return order.body.order_id as string;
  };
  const events = async (orderId: string) =>
    (await h.pool.query('SELECT type FROM order_events WHERE order_id = $1 ORDER BY order_event_id', [orderId])).rows.map(
      (row) => row.type,
    );
  const health = async (orderId: string) => {
    const view = await h.api('GET', `/api/v1/orders/${orderId}`, { token: await h.token('admin.se') });
    return Object.fromEntries(
      view.body.shipments.map((s: { node_id: string; reservation_health: string }) => [s.node_id, s.reservation_health]),
    );
  };

  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.reset('S1');
  });

  describe('the deadline before approval', () => {
    it('does not renew an order awaiting approval', async () => {
      const order = await h.placeOrder(100);
      await leaveMinutes(order.body.order_id, 5);
      const before = await localReservations(order.body.order_id);
      await renew();
      const after = await localReservations(order.body.order_id);
      expect(after.map((r) => r.expires_at)).toEqual(before.map((r) => r.expires_at));
      expect(after.every((r) => r.last_renewed_at === null)).toBe(true);
    });

    it('does not renew the approved part of an order that another node has not approved', async () => {
      const order = await h.placeOrder(100);
      await h.act(order.body.order_id, STORE_B, 'approve');
      await leaveMinutes(order.body.order_id, 5);
      await renew();
      const rows = await localReservations(order.body.order_id);
      expect(rows.every((r) => r.last_renewed_at === null)).toBe(true);
    });

    it('checks the source before approving: a reservation gone at the source blocks approval', async () => {
      const order = await h.placeOrder(30);
      await h.simPool.query(`UPDATE reservations SET expires_at = now() - interval '1 second'`);
      await h.sweepSource();
      const response = await h.act(order.body.order_id, STORE_B, 'approve');
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('RESERVATION_EXPIRED');
      const view = await h.api('GET', `/api/v1/orders/${order.body.order_id}`, { token: await h.token('admin.se') });
      expect(view.body.status).toBe('EXPIRED');
    });

    it('checks every node at the final approval, not only the approver\'s', async () => {
      const order = await h.placeOrder(100);
      await h.act(order.body.order_id, STORE_B, 'approve');
      const [b] = await localReservations(order.body.order_id).then((rows) => rows.filter((r) => r.node_id === STORE_B));
      await h.simPool.query(`UPDATE reservations SET expires_at = now() - interval '1 second' WHERE id = $1`, [b.external_ref]);
      const response = await h.act(order.body.order_id, HUB, 'approve');
      expect(response.status).toBe(409);
    });

    it('refuses to approve when the source cannot confirm, and changes nothing', async () => {
      const order = await h.placeOrder(30);
      await h.outage(true);
      const response = await h.act(order.body.order_id, STORE_B, 'approve');
      expect(response.status).toBe(503);
      expect(response.body.error.code).toBe('SOURCE_UNAVAILABLE');
      expect((await h.tasks(order.body.order_id))[0]!.status).toBe('PENDING_APPROVAL');
      await h.outage(false);
      expect((await h.act(order.body.order_id, STORE_B, 'approve')).status).toBe(200);
    });
  });

  describe('renewal after approval', () => {
    it('renews straight away at final approval, for every node', async () => {
      const order = await h.placeOrder(100);
      await leaveMinutes(order.body.order_id, 1);
      await h.act(order.body.order_id, STORE_B, 'approve');
      await h.act(order.body.order_id, HUB, 'approve');
      const rows = await localReservations(order.body.order_id);
      for (const row of rows) {
        expect(row.last_renewed_at).toBeTruthy();
        expect(row.expires_at.getTime()).toBeGreaterThan(Date.now() + 25 * 60_000);
      }
    });

    it('a dispatch hours after approval still works, with stock held throughout', async () => {
      const orderId = await approved();
      // Six renewal cycles of a nearly expired reservation, 30 minutes each: three hours.
      for (let cycle = 0; cycle < 6; cycle += 1) {
        await leaveMinutes(orderId, 2);
        await renew();
        expect(await h.sweepSource()).toBe(0);
        expect((await h.stock(STORE_B)).reserved).toBe(54);
        expect((await h.stock(HUB)).reserved).toBe(46);
      }
      const rows = await h.simPool.query(`SELECT extension_count FROM reservations ORDER BY node_id`);
      expect(rows.rows.every((row) => row.extension_count >= 6)).toBe(true);

      expect((await h.act(orderId, STORE_B, 'dispatch')).status).toBe(200);
      expect((await h.act(orderId, HUB, 'dispatch')).body.order_status).toBe('DISPATCHED');
      expect(await h.stock(STORE_B)).toEqual({ on_hand: 6, reserved: 0 });
      expect(await h.stock(HUB)).toEqual({ on_hand: 14, reserved: 0 });
    });

    it('shows the renewed expiry on the order, and none once nothing is held', async () => {
      const order = await h.placeOrder(30);
      const before = Date.parse(order.body.reservation_expires_at);
      await new Promise((resolve) => setTimeout(resolve, 20));
      await h.act(order.body.order_id, STORE_B, 'approve');
      const token = await h.token('admin.se');
      const approvedView = await h.api('GET', `/api/v1/orders/${order.body.order_id}`, { token });
      expect(Date.parse(approvedView.body.reservation_expires_at)).toBeGreaterThan(before);
      await h.act(order.body.order_id, STORE_B, 'dispatch');
      const dispatched = await h.api('GET', `/api/v1/orders/${order.body.order_id}`, { token });
      expect(dispatched.body.reservation_expires_at).toBeNull();
    });

    it('does not renew a reservation with plenty of time left', async () => {
      const orderId = await approved();
      const before = await h.simPool.query('SELECT extension_count FROM reservations ORDER BY node_id');
      await renew();
      const after = await h.simPool.query('SELECT extension_count FROM reservations ORDER BY node_id');
      expect(after.rows).toEqual(before.rows);
      expect(orderId).toBeTruthy();
    });

    it('stops at dispatch, even for a split order still being dispatched', async () => {
      const orderId = await approved();
      await h.act(orderId, STORE_B, 'dispatch');
      await leaveMinutes(orderId, 2, HUB);
      await renew();
      const rows = await localReservations(orderId);
      const b = rows.find((row) => row.node_id === STORE_B)!;
      const hub = rows.find((row) => row.node_id === HUB)!;
      expect(b.status).toBe('COMMITTED');
      expect(hub.expires_at.getTime()).toBeGreaterThan(Date.now() + 25 * 60_000);
      const source = await h.simPool.query(`SELECT extension_count FROM reservations WHERE id = $1`, [b.external_ref]);
      expect(source.rows[0].extension_count).toBe(1); // Only the one at approval.
    });

    it('an admin may cancel an approved order: stock is released and renewal stops', async () => {
      const orderId = await approved();
      const cancelled = await h.api('POST', `/api/v1/orders/${orderId}/cancel`, { token: await h.token('admin.se') });
      expect(cancelled.status).toBe(200);
      expect(cancelled.body.status).toBe('CANCELLED');
      expect((await h.stock(STORE_B)).reserved).toBe(0);
      const before = await h.simPool.query('SELECT extension_count, status FROM reservations ORDER BY node_id');
      await renew();
      const after = await h.simPool.query('SELECT extension_count, status FROM reservations ORDER BY node_id');
      expect(after.rows).toEqual(before.rows);
      expect(after.rows.every((row) => row.status === 'RELEASED')).toBe(true);
    });

    it('a customer may not cancel once approved', async () => {
      const orderId = await approved();
      const refused = await h.api('POST', `/api/v1/orders/${orderId}/cancel`, { token: await h.token('buyer.nordbygg') });
      expect(refused.status).toBe(409);
      expect((await h.stock(STORE_B)).reserved).toBe(54);
    });

    it('nobody can cancel after dispatch has begun', async () => {
      const orderId = await approved();
      await h.act(orderId, STORE_B, 'dispatch');
      const refused = await h.api('POST', `/api/v1/orders/${orderId}/cancel`, { token: await h.token('admin.se') });
      expect(refused.status).toBe(409);
    });
  });

  describe('concurrency', () => {
    it('concurrent renewals and a dispatch leave stock correct', async () => {
      const orderId = await approved();
      await leaveMinutes(orderId, 2);
      const [dispatch] = await Promise.all([h.act(orderId, STORE_B, 'dispatch'), renew(), renew(), renew()]);
      expect(dispatch.status).toBe(200);
      await renew();
      expect(await h.stock(STORE_B)).toEqual({ on_hand: 6, reserved: 0 });
      expect(await h.stock(HUB)).toEqual({ on_hand: 60, reserved: 46 });
      const rows = await localReservations(orderId);
      expect(rows.find((row) => row.node_id === STORE_B)!.status).toBe('COMMITTED');
      expect(rows.find((row) => row.node_id === HUB)!.status).toBe('ACTIVE');
    });

    it('two concurrent dispatches commit the stock once', async () => {
      const orderId = await approved();
      const results = await Promise.all([h.act(orderId, STORE_B, 'dispatch'), h.act(orderId, STORE_B, 'dispatch')]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(await h.stock(STORE_B)).toEqual({ on_hand: 6, reserved: 0 });
      const ledger = await h.simPool.query(`SELECT count(*)::int AS n FROM stock_ledger WHERE type = 'OUTBOUND'`);
      expect(ledger.rows[0].n).toBe(1);
    });

    it('a renewal racing a cancel never brings a reservation back', async () => {
      const orderId = await approved();
      await leaveMinutes(orderId, 2);
      const [cancelled] = await Promise.all([
        h.api('POST', `/api/v1/orders/${orderId}/cancel`, { token: await h.token('admin.se') }),
        renew(),
      ]);
      expect(cancelled.status).toBe(200);
      await h.app.container.reservations.tick();
      expect((await h.stock(STORE_B)).reserved).toBe(0);
      expect((await h.stock(HUB)).reserved).toBe(0);
    });
  });

  describe('failures', () => {
    it('during an outage the problem is visible, retried, reported once, and dispatch is refused safely', async () => {
      const orderId = await approved();
      await leaveMinutes(orderId, 2);
      await h.outage(true);
      await renew();
      await renew();

      expect(await health(orderId)).toEqual({ [STORE_B]: 'RENEWAL_FAILING', [HUB]: 'RENEWAL_FAILING' });
      const failures = (await events(orderId)).filter((type) => type === 'reservation.renewal_failed');
      expect(failures).toHaveLength(2); // One per node, not one per attempt.
      const rows = await localReservations(orderId);
      expect(rows.every((row) => row.renewal_attempts === 2)).toBe(true);

      const refused = await h.act(orderId, STORE_B, 'dispatch');
      expect(refused.status).toBe(503);
      expect((await h.tasks(orderId)).every((task) => task.status === 'APPROVED')).toBe(true);

      await h.outage(false);
      await renew();
      expect(await health(orderId)).toEqual({ [STORE_B]: 'OK', [HUB]: 'OK' });
      expect((await events(orderId)).filter((type) => type === 'reservation.renewal_recovered')).toHaveLength(2);
      expect((await h.act(orderId, STORE_B, 'dispatch')).status).toBe(200);
    });

    it('a reservation lost at the source blocks dispatch from that node only', async () => {
      const orderId = await approved();
      const hub = (await localReservations(orderId)).find((row) => row.node_id === HUB)!;
      await h.simPool.query(`UPDATE reservations SET expires_at = now() - interval '1 second' WHERE id = $1`, [hub.external_ref]);
      await leaveMinutes(orderId, 2, STORE_B);
      await h.pool.query(`UPDATE reservations SET expires_at = now() + interval '2 minutes' WHERE reservation_id = $1`, [
        hub.reservation_id,
      ]);
      await h.sweepSource();
      await renew();

      expect(await health(orderId)).toEqual({ [STORE_B]: 'OK', [HUB]: 'LOST' });
      expect(await events(orderId)).toContain('reservation.lost');

      const blocked = await h.act(orderId, HUB, 'dispatch');
      expect(blocked.status).toBe(409);
      expect(blocked.body.error.code).toBe('RESERVATION_LOST');
      expect((await h.stock(HUB)).reserved).toBe(0);
      expect((await h.stock(HUB)).on_hand).toBe(60);

      expect((await h.act(orderId, STORE_B, 'dispatch')).status).toBe(200);
      const view = await h.api('GET', `/api/v1/orders/${orderId}`, { token: await h.token('admin.se') });
      expect(view.body.status).toBe('DISPATCHING');
    });

    it('a reservation that expired unnoticed is caught at dispatch, not assumed', async () => {
      const orderId = await approved();
      const b = (await localReservations(orderId)).find((row) => row.node_id === STORE_B)!;
      await h.simPool.query(`UPDATE reservations SET expires_at = now() - interval '1 second' WHERE id = $1`, [b.external_ref]);
      const response = await h.act(orderId, STORE_B, 'dispatch');
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('RESERVATION_LOST');
      expect(await health(orderId)).toMatchObject({ [STORE_B]: 'LOST' });
      expect(await h.stock(STORE_B)).toEqual({ on_hand: 60, reserved: 0 });
      const ledger = await h.simPool.query(`SELECT count(*)::int AS n FROM stock_ledger WHERE type = 'OUTBOUND'`);
      expect(ledger.rows[0].n).toBe(0);
    });

    it('an approved order that lost a reservation can be cancelled by an admin', async () => {
      const orderId = await approved();
      const b = (await localReservations(orderId)).find((row) => row.node_id === STORE_B)!;
      await h.simPool.query(`UPDATE reservations SET expires_at = now() - interval '1 second' WHERE id = $1`, [b.external_ref]);
      await h.act(orderId, STORE_B, 'dispatch');
      const cancelled = await h.api('POST', `/api/v1/orders/${orderId}/cancel`, { token: await h.token('admin.se') });
      expect(cancelled.body.status).toBe('CANCELLED');
      expect((await h.stock(HUB)).reserved).toBe(0);
    });

    it('a failed renewal at final approval does not undo the approval', async () => {
      const order = await h.placeOrder(100);
      await h.act(order.body.order_id, STORE_B, 'approve');
      const client = h.app.container.simulator;
      const original = client.extend.bind(client);
      client.extend = () => Promise.reject(new SourceUnavailableError('boom'));
      const response = await h.act(order.body.order_id, HUB, 'approve');
      client.extend = original;
      expect(response.status).toBe(200);
      expect(response.body.order_status).toBe('APPROVED');
      expect(await health(order.body.order_id)).toEqual({ [STORE_B]: 'RENEWAL_FAILING', [HUB]: 'RENEWAL_FAILING' });
      // The next worker tick repairs it.
      await h.app.container.reservations.renewOrder(order.body.order_id);
      expect(await health(order.body.order_id)).toEqual({ [STORE_B]: 'OK', [HUB]: 'OK' });
    });
  });
});
