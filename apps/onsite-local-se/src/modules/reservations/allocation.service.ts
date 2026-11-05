import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../../config.js';
import { SourceRejectedError, SourceUnavailableError, type SimulatorClient } from '../../connectors/simulator.js';
import { withTransaction, type Db } from '../../db.js';
import { AppError } from '../../errors.js';
import { inTx } from '../../tx.js';
import * as catalog from '../catalog/catalog.repository.js';
import type { EtaService } from '../eta/eta.service.js';
import type { Freshness } from '../inventory/freshness.js';
import type { InventoryService } from '../inventory/inventory.service.js';
import { bumpCounter, COUNTERS } from '../metrics/counters.js';
import type { NotificationHub } from '../notifications/hub.js';
import * as orders from '../orders/orders.repository.js';
import { planAllocation, type AllocationPlan, type PlannedAllocation } from '../routing/plan.js';
import type { ReservationsService } from './reservations.service.js';

export type ReviewReason =
  | 'INSUFFICIENT_STOCK'
  | 'SOURCE_UNAVAILABLE'
  | 'INVENTORY_STALE'
  | 'RESERVATION_CONFLICT'
  | 'ALLOCATION_INTERRUPTED';

type Attempt =
  | { kind: 'ok'; allocations: (PlannedAllocation & { allocation_id: string })[] }
  | { kind: 'conflict' }
  | { kind: 'unavailable' };

function staleReason(freshness: Freshness): ReviewReason {
  return freshness.staleReason === 'LAST_SYNC_FAILED' || freshness.staleReason === 'CONNECTOR_DISABLED'
    ? 'SOURCE_UNAVAILABLE'
    : 'INVENTORY_STALE';
}

export class AllocationService {
  constructor(
    private readonly pool: Db,
    private readonly hub: NotificationHub,
    private readonly config: Config,
    private readonly simulator: SimulatorClient,
    private readonly inventory: InventoryService,
    private readonly reservations: ReservationsService,
    private readonly eta: EtaService,
    private readonly log: FastifyBaseLogger,
  ) {}

  /**
   * The reservation saga. The order must be ALLOCATING. Plans what is still missing, reserves at each
   * node, and on a conflict releases what it holds, re-reads stock and tries again. There is no
   * transaction across Local SE and the source: each intent is stored before the call so that a crash
   * can be cleaned up, and each confirmation after it.
   */
  async allocate(orderId: string, actor: string): Promise<void> {
    const order = (await orders.getOrder(this.pool, orderId))!;
    const site = (await catalog.getSite(this.pool, order.site_id))!;
    const nodes = await catalog.listStores(this.pool);
    const items = await orders.listItems(this.pool, orderId);
    const skuIds = [...new Set(items.map((item) => item.sku_id))];
    let lastFulfillable: number | undefined;

    for (let attempt = 0; attempt <= this.config.reservation.maxRetries; attempt += 1) {
      if (attempt > 0) await this.inventory.sync();
      let freshness = await this.inventory.freshness();
      if (!freshness.trusted) {
        await this.inventory.sync();
        freshness = await this.inventory.freshness();
      }
      if (!freshness.trusted) {
        await this.fail(orderId, staleReason(freshness), actor);
        return;
      }

      const plan = await this.plan(orderId, order, site, nodes, items, skuIds);
      lastFulfillable = plan.fulfillable_qty + (await this.heldQuantity(orderId));
      if (plan.status === 'SHORTAGE') {
        await this.fail(orderId, 'INSUFFICIENT_STOCK', actor, lastFulfillable);
        return;
      }

      const result = await this.reserveAll(orderId, plan.allocations);
      if (result.kind === 'ok') {
        await this.finalize(orderId, result.allocations, freshness, actor);
        return;
      }
      if (result.kind === 'unavailable') {
        await this.fail(orderId, 'SOURCE_UNAVAILABLE', actor);
        return;
      }
      await bumpCounter(this.pool, COUNTERS.reservationConflicts);
    }
    await this.fail(orderId, 'RESERVATION_CONFLICT', actor, lastFulfillable);
  }

  /**
   * What could be supplied right now, line by line, by the same planner that allocates. Only for an order
   * that holds nothing, so the answer is not offset by its own reservations. Promises nothing: stock can
   * change before the order is allocated again.
   */
  async availableNow(orderId: string): Promise<{ item_id: string; sku_id: string; requested: number; available: number }[]> {
    let freshness = await this.inventory.freshness();
    if (!freshness.trusted) {
      await this.inventory.sync();
      freshness = await this.inventory.freshness();
    }
    if (!freshness.trusted) {
      throw new AppError(503, 'SOURCE_UNAVAILABLE', 'Stock cannot be confirmed right now; try again shortly');
    }
    const order = (await orders.getOrder(this.pool, orderId))!;
    const site = (await catalog.getSite(this.pool, order.site_id))!;
    const items = await orders.listItems(this.pool, orderId);
    const skuIds = [...new Set(items.map((item) => item.sku_id))];
    const plan = await this.plan(orderId, order, site, await catalog.listStores(this.pool), items, skuIds);
    return items.map((item) => {
      const shortage = plan.shortages.find((line) => line.item_id === item.item_id);
      return {
        item_id: item.item_id,
        sku_id: item.sku_id,
        requested: item.quantity,
        available: shortage ? shortage.fulfillable : item.quantity,
      };
    });
  }

  private async heldQuantity(orderId: string): Promise<number> {
    const held = await orders.listAllocations(this.pool, orderId);
    return held.reduce((total, allocation) => total + allocation.quantity, 0);
  }

  private async plan(
    orderId: string,
    order: orders.Order,
    site: catalog.SiteRow,
    nodes: catalog.StoreRow[],
    items: orders.Item[],
    skuIds: string[],
  ): Promise<AllocationPlan> {
    const held = await orders.listAllocations(this.pool, orderId);
    const tasks = await orders.listTasks(this.pool, orderId);
    // A node that refused is not asked again, and an approved task must not grow behind its approver's back.
    const excludedNodes = tasks
      .filter((task) => task.status === 'REJECTED' || task.status === 'APPROVED')
      .map((task) => task.node_id);
    const lines = items
      .map((item) => ({
        item_id: item.item_id,
        sku_id: item.sku_id,
        quantity:
          item.quantity -
          held.filter((allocation) => allocation.item_id === item.item_id).reduce((sum, a) => sum + a.quantity, 0),
      }))
      .filter((line) => line.quantity > 0);
    const stock = await this.inventory.usableStock(skuIds);
    // Circuit breaker: a node whose server has stopped reporting may have sold this stock at the counter.
    const offline = new Set(await catalog.listOfflineNodeIds(this.pool, this.config.nodes.heartbeatTimeoutSeconds));
    return planAllocation({
      lines,
      site: { lat: site.lat, lng: site.lng },
      salesStoreId: order.sales_store_id,
      now: new Date(),
      nodes: nodes.map((node) => ({
        node_id: node.store_id,
        lat: node.lat,
        lng: node.lng,
        prep_minutes: node.prep_minutes,
        active: node.status === 'ACTIVE',
      })),
      inventory: stock.map((row) => ({
        node_id: row.node_id,
        sku_id: row.sku_id,
        usable: row.usable,
        stale: offline.has(row.node_id),
      })),
      excludedNodes,
      eta: this.config.eta,
      maxSourcesPerLine: this.config.routing.maxSourcesPerLine,
    });
  }

  private async reserveAll(orderId: string, planned: PlannedAllocation[]): Promise<Attempt> {
    const ttlMinutes = this.config.reservation.ttlMinutes;
    const intents = await withTransaction(this.pool, async (client) => {
      const created = [];
      for (const allocation of planned) {
        const allocationId = randomUUID();
        await orders.insertAllocation(client, {
          allocation_id: allocationId,
          item_id: allocation.item_id,
          node_id: allocation.node_id,
          quantity: allocation.quantity,
          routing_reason: allocation.routing_reason,
        });
        const key = `${orderId}:${allocationId}`;
        const reservationId = await orders.insertReservationIntent(client, { allocationId, key, ttlMinutes });
        created.push({ ...allocation, allocation_id: allocationId, key, reservationId });
      }
      return created;
    });

    let failure: Attempt | undefined;
    for (const intent of intents) {
      try {
        const reservation = await this.simulator.reserve(
          { node_id: intent.node_id, sku_id: intent.sku_id, qty: intent.quantity, ttl_minutes: ttlMinutes },
          intent.key,
        );
        await orders.confirmReservation(
          this.pool,
          intent.reservationId,
          reservation.reservation_id,
          reservation.expires_at,
        );
        if (reservation.inventory) await this.inventory.applySourceStock(reservation.inventory);
      } catch (error) {
        if (error instanceof SourceRejectedError) failure = { kind: 'conflict' };
        else if (error instanceof SourceUnavailableError) failure = { kind: 'unavailable' };
        else throw error;
        break;
      }
    }
    if (!failure) return { kind: 'ok', allocations: intents };

    const allocationIds = intents.map((intent) => intent.allocation_id);
    await withTransaction(this.pool, async (client) => {
      await orders.markReservationsReleasing(client, { allocationIds });
      await orders.releaseAllocations(client, { allocationIds });
    });
    await this.reservations.releaseQueued(orderId);
    return failure;
  }

  private async finalize(
    orderId: string,
    allocations: (PlannedAllocation & { allocation_id: string })[],
    freshness: Freshness,
    actor: string,
  ): Promise<void> {
    await inTx(this.pool, this.hub, async (tx) => {
      let order = await orders.lockOrder(tx.client, orderId);
      const allocationIds = allocations.map((allocation) => allocation.allocation_id);
      if (order.status !== 'ALLOCATING') {
        // Cancelled while the saga was running: what it reserved must go back.
        await orders.markReservationsReleasing(tx.client, { allocationIds });
        await orders.releaseAllocations(tx.client, { allocationIds });
        tx.afterCommit(() => this.reservations.releaseQueued(orderId));
        return;
      }

      const tasks = await orders.listTasks(tx.client, orderId);
      for (const nodeId of [...new Set(allocations.map((allocation) => allocation.node_id))]) {
        const ids = allocations.filter((a) => a.node_id === nodeId).map((a) => a.allocation_id);
        const pending = tasks.find((task) => task.node_id === nodeId && task.status === 'PENDING_APPROVAL');
        const task = pending ?? (await orders.createTask(tx, orderId, nodeId));
        await orders.assignAllocations(tx.client, task.task_id, ids);
        if (pending) await orders.bumpTaskVersion(tx.client, task.task_id);
        order = await orders.changeOrder(
          tx,
          order,
          {},
          {
            type: pending ? 'task.quantity_added' : 'task.assigned',
            actor,
            data: { task_id: task.task_id, node_id: nodeId },
            publicData: { node_id: nodeId, task_status: 'PENDING_APPROVAL' },
          },
          this.config.countryCode,
        );
        tx.notify({
          type: pending ? 'task.updated' : 'task.assigned',
          scope: { nodeIds: [nodeId] },
          data: { task_id: task.task_id, order_id: orderId },
        });
      }

      const expiresAt = await orders.earliestActiveExpiry(tx.client, orderId);
      order = await this.eta.refresh(tx, order);
      await orders.transitionOrder(tx, order, 'AWAITING_APPROVAL', actor, this.config.countryCode, {
        reservation_expires_at: expiresAt,
        inventory_as_of: freshness.lastSuccessfulSyncAt,
        review_reason: null,
        fulfillable_qty: null,
      });
    });
    await this.reservations.releaseQueued(orderId);
  }

  /** No commitment could be made: nothing stays held, and the order says why and what could be supplied. */
  private async fail(orderId: string, reason: ReviewReason, actor: string, fulfillable?: number): Promise<void> {
    await inTx(this.pool, this.hub, async (tx) => {
      let order = await orders.lockOrder(tx.client, orderId);
      if (order.status === 'ALLOCATING') {
        for (const task of await orders.listTasks(tx.client, orderId)) {
          if (task.status === 'PENDING_APPROVAL' || task.status === 'APPROVED') {
            ({ order } = await orders.transitionTask(tx, order, task, 'CANCELLED', actor, this.config.countryCode));
          }
        }
        order = await orders.transitionOrder(
          tx,
          order,
          'NEEDS_REVIEW',
          actor,
          this.config.countryCode,
          {
            review_reason: reason,
            fulfillable_qty: fulfillable ?? null,
            early_shortage_detected: reason === 'INSUFFICIENT_STOCK',
            reservation_expires_at: null,
          },
          { reason, fulfillable_qty: fulfillable ?? null },
          { reason },
        );
      }
      await orders.markReservationsReleasing(tx.client, { orderId });
      await orders.releaseAllocations(tx.client, { orderId });
    });
    await this.reservations.releaseQueued(orderId);
  }

  /** Worker: an allocation stopped by a crash must not keep stock or leave the order in limbo. */
  async recoverInterrupted(): Promise<void> {
    const ids = await orders.listInterruptedOrderIds(this.pool, this.config.reservation.interruptedAfterSeconds);
    for (const orderId of ids) {
      this.log.warn({ order_id: orderId }, 'closing an interrupted allocation');
      await inTx(this.pool, this.hub, async (tx) => {
        const order = await orders.lockOrder(tx.client, orderId);
        if (order.status === 'SUBMITTED' || order.status === 'NEEDS_REALLOCATION') {
          await orders.transitionOrder(tx, order, 'ALLOCATING', 'system', this.config.countryCode);
        }
      });
      await this.fail(orderId, 'ALLOCATION_INTERRUPTED', 'system');
    }
    await orders.purgeExpiredIdempotency(this.pool);
  }
}
