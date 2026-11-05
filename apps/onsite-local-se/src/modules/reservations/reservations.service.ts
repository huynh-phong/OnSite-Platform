import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../../config.js';
import { SourceRejectedError, SourceUnavailableError, type SimulatorClient } from '../../connectors/simulator.js';
import type { Db } from '../../db.js';
import { inTx } from '../../tx.js';
import type { InventoryService } from '../inventory/inventory.service.js';
import { bumpCounter, COUNTERS } from '../metrics/counters.js';
import type { NotificationHub } from '../notifications/hub.js';
import * as orders from '../orders/orders.repository.js';

export type ReservationValidity = 'VALID' | 'INVALID' | 'UNKNOWN';

export class ReservationsService {
  constructor(
    private readonly pool: Db,
    private readonly hub: NotificationHub,
    private readonly config: Config,
    private readonly simulator: SimulatorClient,
    private readonly inventory: InventoryService,
    private readonly log: FastifyBaseLogger,
  ) {}

  /**
   * Sends decided releases to the source. One that cannot get through stays RELEASING and is retried,
   * and the source's own expiry bounds how long the stock can stay held. Never throws.
   */
  async releaseQueued(orderId?: string): Promise<void> {
    for (const reservation of await orders.listReleasing(this.pool, orderId)) {
      try {
        if (reservation.external_ref) {
          const result = await this.simulator.release(reservation.external_ref);
          if (result.inventory) await this.inventory.applySourceStock(result.inventory);
          await orders.setReservationStatus(
            this.pool,
            reservation.reservation_id,
            result.status === 'EXPIRED' ? 'EXPIRED' : 'RELEASED',
          );
        } else if (reservation.idempotency_key) {
          const result = await this.simulator.releaseByKey(reservation.idempotency_key);
          if (result.inventory) await this.inventory.applySourceStock(result.inventory);
          await orders.setReservationStatus(this.pool, reservation.reservation_id, 'RELEASED');
        }
      } catch (error) {
        if (error instanceof SourceRejectedError && error.sourceStatus === 'COMMITTED') {
          this.log.error({ reservation_id: reservation.reservation_id }, 'release refused: already committed');
          await orders.setReservationStatus(this.pool, reservation.reservation_id, 'COMMITTED');
        } else if (error instanceof SourceRejectedError && error.status === 404) {
          await orders.setReservationStatus(this.pool, reservation.reservation_id, 'RELEASED');
        } else {
          this.log.warn({ reservation_id: reservation.reservation_id }, 'release deferred: source unavailable');
        }
      }
    }
  }

  /** Asks the source about every active reservation of the order. It has the final say, not the local copy. */
  async verifyForApproval(orderId: string): Promise<ReservationValidity> {
    const reservations = (await orders.listOrderReservations(this.pool, orderId)).filter(
      (reservation) => reservation.status === 'ACTIVE',
    );
    if (reservations.length === 0) return 'INVALID';
    for (const reservation of reservations) {
      if (!reservation.external_ref || reservation.expires_at.getTime() <= Date.now()) return 'INVALID';
      try {
        const current = await this.simulator.getReservation(reservation.external_ref);
        if (current.status !== 'ACTIVE') return 'INVALID';
      } catch (error) {
        if (error instanceof SourceUnavailableError) return 'UNKNOWN';
        if (error instanceof SourceRejectedError) return 'INVALID';
        throw error;
      }
    }
    return 'VALID';
  }

  /**
   * Renews reservations of approved orders that are about to run out. Orders still awaiting approval are
   * not selected, so their deadline stays in force. Each reservation is handled independently: one node
   * failing does not affect the others.
   */
  async renewDue(): Promise<void> {
    const due = await orders.listRenewalDue(this.pool, this.config.reservation.renewWithinMinutes);
    for (const reservation of due) await this.renewOne(reservation);
  }

  /** Immediately after final approval: gives the whole order a full TTL. */
  async renewOrder(orderId: string): Promise<void> {
    const reservations = await orders.listRenewalDue(this.pool, 0, orderId);
    for (const reservation of reservations) await this.renewOne(reservation);
  }

  private async renewOne(reservation: orders.Reservation): Promise<void> {
    if (!reservation.external_ref) return;
    try {
      const renewed = await this.simulator.extend(reservation.external_ref, this.config.reservation.ttlMinutes);
      const wasFailing = Boolean(reservation.renewal_error);
      await orders.recordRenewal(this.pool, reservation.reservation_id, renewed.expires_at);
      await bumpCounter(this.pool, COUNTERS.renewals);
      if (wasFailing) await this.recordEvent(reservation, 'reservation.renewal_recovered');
    } catch (error) {
      await bumpCounter(this.pool, COUNTERS.renewalFailures);
      if (error instanceof SourceRejectedError) {
        await this.markLost(reservation, error.sourceStatus ?? error.code);
        return;
      }
      const message = error instanceof SourceUnavailableError ? 'SOURCE_UNAVAILABLE' : 'RENEWAL_ERROR';
      await orders.recordRenewalFailure(this.pool, reservation.reservation_id, message);
      // Reported once per failure episode; retries continue on every tick.
      if (reservation.renewal_attempts === 0) await this.recordEvent(reservation, 'reservation.renewal_failed');
    }
  }

  /** The source no longer holds this stock. Dispatch from it is blocked and the problem is visible. */
  async markLost(reservation: orders.Reservation, reason: string): Promise<void> {
    await inTx(this.pool, this.hub, async (tx) => {
      const changed = await orders.recordReservationLost(tx.client, reservation.reservation_id, reason);
      if (!changed) return;
      const order = await orders.lockOrder(tx.client, reservation.order_id);
      await orders.changeOrder(
        tx,
        order,
        {},
        {
          type: 'reservation.lost',
          actor: 'system',
          data: { node_id: reservation.node_id, sku_id: reservation.sku_id, reason },
          publicData: { node_id: reservation.node_id },
        },
        this.config.countryCode,
      );
      await bumpCounter(tx.client, COUNTERS.reservationsLost);
      tx.notify({
        type: 'task.updated',
        scope: { nodeIds: [reservation.node_id] },
        data: { task_id: reservation.task_id, order_id: reservation.order_id, reservation_health: 'LOST' },
      });
    });
  }

  private async recordEvent(reservation: orders.Reservation, type: string): Promise<void> {
    await inTx(this.pool, this.hub, async (tx) => {
      const order = await orders.lockOrder(tx.client, reservation.order_id);
      await orders.changeOrder(
        tx,
        order,
        {},
        {
          type,
          actor: 'system',
          data: { node_id: reservation.node_id, sku_id: reservation.sku_id },
          publicData: { node_id: reservation.node_id },
        },
        this.config.countryCode,
      );
      tx.notify({
        type: 'task.updated',
        scope: { nodeIds: [reservation.node_id] },
        data: { task_id: reservation.task_id, order_id: reservation.order_id, event: type },
      });
    });
  }

  /** The approval deadline passed: close the tasks and the order, then give the stock back. */
  async expireOrder(orderId: string, actor = 'system'): Promise<void> {
    await inTx(this.pool, this.hub, async (tx) => {
      let order = await orders.lockOrder(tx.client, orderId);
      if (order.status !== 'AWAITING_APPROVAL') return;
      for (const task of await orders.listTasks(tx.client, orderId)) {
        if (task.status === 'PENDING_APPROVAL' || task.status === 'APPROVED') {
          ({ order } = await orders.transitionTask(tx, order, task, 'EXPIRED', actor, this.config.countryCode));
        }
      }
      await orders.markReservationsReleasing(tx.client, { orderId });
      await orders.releaseAllocations(tx.client, { orderId });
      await orders.transitionOrder(tx, order, 'EXPIRED', actor, this.config.countryCode, {
        reservation_expires_at: null,
      });
    });
    await this.releaseQueued(orderId);
  }

  /** Worker: expires unapproved orders and retries releases that could not get through. */
  async tick(): Promise<void> {
    for (const orderId of await orders.listExpiredOrderIds(this.pool)) await this.expireOrder(orderId);
    await this.releaseQueued();
  }
}
