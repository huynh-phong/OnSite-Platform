import { createHash } from 'node:crypto';
import type { Principal } from '../../auth.js';
import type { Config } from '../../config.js';
import type { Db } from '../../db.js';
import { AppError } from '../../errors.js';
import { inTx } from '../../tx.js';
import * as catalog from '../catalog/catalog.repository.js';
import type { NotificationHub } from '../notifications/hub.js';
import type { AllocationService } from '../reservations/allocation.service.js';
import type { ReservationsService } from '../reservations/reservations.service.js';
import * as repo from './orders.repository.js';
import { LIVE_TASK_STATUSES, type OrderStatus } from './state-machine.js';

export interface CreateOrderBody {
  sales_store_id: string;
  site_id: string;
  requested_delivery_at: string;
  items: { sku_id: string; quantity: number; unit: string }[];
}

/** Customers may cancel only before approval. After it, only an admin can. */
const CUSTOMER_CANCELLABLE: readonly OrderStatus[] = [
  'SUBMITTED',
  'ALLOCATING',
  'AWAITING_APPROVAL',
  'NEEDS_REVIEW',
  'NEEDS_REALLOCATION',
];

export type ReservationHealth = 'OK' | 'RENEWAL_FAILING' | 'LOST' | 'NOT_APPLICABLE';

export function reservationHealth(taskStatus: string, reservations: repo.Reservation[]): ReservationHealth {
  if (taskStatus !== 'APPROVED') return 'NOT_APPLICABLE';
  if (reservations.some((reservation) => reservation.status === 'EXPIRED')) return 'LOST';
  if (reservations.some((reservation) => reservation.renewal_error)) return 'RENEWAL_FAILING';
  return 'OK';
}

function requestHash(body: CreateOrderBody): string {
  const canonical = {
    sales_store_id: body.sales_store_id,
    site_id: body.site_id,
    requested_delivery_at: new Date(body.requested_delivery_at).toISOString(),
    items: body.items.map((item) => [item.sku_id, item.quantity, item.unit]),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export class OrdersService {
  constructor(
    private readonly pool: Db,
    private readonly hub: NotificationHub,
    private readonly config: Config,
    private readonly allocation: AllocationService,
    private readonly reservations: ReservationsService,
  ) {}

  /** Creates and allocates an order. Safe to retry with the same Idempotency-Key. */
  async create(principal: Principal, key: string, body: CreateOrderBody): Promise<{ statusCode: number; body: unknown }> {
    const hash = requestHash(body);
    // A retry gets the stored answer, even if the catalog has changed since the first attempt.
    const known = await repo.findIdempotencyRecord(this.pool, principal.sub, key);
    if (known) return this.replay(principal, known, hash);

    await this.validate(principal, body);
    const products = await catalog.getProducts(
      this.pool,
      body.items.map((item) => item.sku_id),
    );

    const start = await inTx(this.pool, this.hub, async (tx) => {
      const existing = await repo.claimIdempotencyKey(tx.client, principal.sub, key, hash);
      if (existing) return { existing };
      const orderId = await repo.nextOrderId(tx.client);
      const order = await repo.insertOrder(tx.client, {
        order_id: orderId,
        customer_id: principal.customer_id!,
        sales_store_id: body.sales_store_id,
        site_id: body.site_id,
        requested_delivery_at: body.requested_delivery_at,
      });
      for (const item of body.items) {
        await repo.insertItem(tx.client, {
          order_id: orderId,
          sku_id: item.sku_id,
          quantity: item.quantity,
          unit: item.unit,
          unit_price: products.find((product) => product.sku_id === item.sku_id)!.unit_price,
        });
      }
      await repo.linkIdempotencyOrder(tx.client, principal.sub, key, orderId);
      const submitted = await repo.changeOrder(
        tx,
        order,
        {},
        { type: 'order.submitted', actor: principal.sub },
        this.config.countryCode,
      );
      await repo.transitionOrder(tx, submitted, 'ALLOCATING', principal.sub, this.config.countryCode);
      return { orderId };
    });

    if (start.existing) return this.replay(principal, start.existing, hash);

    await this.allocation.allocate(start.orderId!, principal.sub);
    const view = await this.view(start.orderId!, principal);
    await repo.storeIdempotencyResponse(this.pool, principal.sub, key, 201, view);
    return { statusCode: 201, body: view };
  }

  private async replay(principal: Principal, record: repo.IdempotencyRecord, hash: string) {
    if (record.request_hash !== hash) {
      throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'This Idempotency-Key was used with a different request');
    }
    if (record.status_code !== null) return { statusCode: record.status_code, body: record.response };
    // First call still running, or it died. In the second case the order is what it is by now.
    const ageSeconds = (Date.now() - record.created_at.getTime()) / 1000;
    if (record.order_id && ageSeconds > this.config.reservation.interruptedAfterSeconds) {
      return { statusCode: 201, body: await this.view(record.order_id, principal) };
    }
    throw new AppError(409, 'IDEMPOTENCY_IN_PROGRESS', 'The first request with this key is still being processed');
  }

  private async validate(principal: Principal, body: CreateOrderBody): Promise<void> {
    if (!principal.customer_id) throw new AppError(403, 'FORBIDDEN', 'This account has no customer');
    const site = await catalog.getSite(this.pool, body.site_id);
    if (!site) throw new AppError(422, 'UNKNOWN_SITE', 'Unknown site');
    if (site.customer_id !== principal.customer_id) throw new AppError(403, 'FORBIDDEN', 'This site belongs to another customer');
    if (!(await catalog.getStore(this.pool, body.sales_store_id))) {
      throw new AppError(422, 'UNKNOWN_STORE', 'Unknown sales store');
    }
    const products = await catalog.getProducts(
      this.pool,
      body.items.map((item) => item.sku_id),
    );
    for (const item of body.items) {
      const product = products.find((candidate) => candidate.sku_id === item.sku_id);
      if (!product || product.status !== 'ACTIVE') {
        throw new AppError(422, 'PRODUCT_NOT_AVAILABLE', `Product ${item.sku_id} is not available`);
      }
      if (product.base_unit !== item.unit) {
        throw new AppError(422, 'UNIT_MISMATCH', `Product ${item.sku_id} is sold in ${product.base_unit}`);
      }
    }
  }

  /** Server-side scope: customers their own orders, staff orders with a task at their node, admins all. */
  async assertCanRead(principal: Principal, order: repo.Order): Promise<void> {
    if (principal.role === 'admin') return;
    if (principal.role === 'customer' && order.customer_id === principal.customer_id) return;
    if (principal.role === 'staff') {
      const tasks = await repo.listTasks(this.pool, order.order_id);
      if (tasks.some((task) => task.node_id === principal.store_id)) return;
    }
    throw new AppError(403, 'FORBIDDEN', 'You may not access this order');
  }

  async get(orderId: string, principal: Principal) {
    const order = await repo.getOrder(this.pool, orderId);
    if (!order) throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found');
    await this.assertCanRead(principal, order);
    return this.view(orderId, principal);
  }

  async list(principal: Principal, status?: string) {
    const rows = await repo.listOrders(this.pool, {
      ...(principal.role === 'customer' ? { customerId: principal.customer_id! } : {}),
      ...(principal.role === 'staff' ? { nodeId: principal.store_id! } : {}),
      ...(status ? { status } : {}),
      limit: 100,
    });
    return rows.map((order) => ({
      order_id: order.order_id,
      status: order.status,
      sales_store_id: order.sales_store_id,
      site_id: order.site_id,
      requested_delivery_at: order.requested_delivery_at.toISOString(),
      eta: order.eta?.toISOString() ?? null,
      at_risk: order.at_risk,
      version: order.version,
      created_at: order.created_at.toISOString(),
    }));
  }

  async cancel(orderId: string, principal: Principal, expectedVersion?: number) {
    await inTx(this.pool, this.hub, async (tx) => {
      let order = await repo.lockOrder(tx.client, orderId);
      if (principal.role === 'customer' && order.customer_id !== principal.customer_id) {
        throw new AppError(403, 'FORBIDDEN', 'You may not access this order');
      }
      if (expectedVersion !== undefined && expectedVersion !== order.version) {
        throw new AppError(409, 'VERSION_CONFLICT', 'Order was changed by someone else');
      }
      if (principal.role === 'customer' && !CUSTOMER_CANCELLABLE.includes(order.status)) {
        throw new AppError(409, 'INVALID_TRANSITION', `A customer cannot cancel an order that is ${order.status}`);
      }
      for (const task of await repo.listTasks(tx.client, orderId)) {
        if (task.status === 'PENDING_APPROVAL' || task.status === 'APPROVED') {
          ({ order } = await repo.transitionTask(tx, order, task, 'CANCELLED', principal.sub, this.config.countryCode));
        }
      }
      await repo.transitionOrder(tx, order, 'CANCELLED', principal.sub, this.config.countryCode, {
        reservation_expires_at: null,
        at_risk: false,
        at_risk_reason: null,
      });
      await repo.markReservationsReleasing(tx.client, { orderId });
      await repo.releaseAllocations(tx.client, { orderId });
    });
    await this.reservations.releaseQueued(orderId);
    return this.view(orderId, principal);
  }

  async view(orderId: string, principal: Principal) {
    const order = (await repo.getOrder(this.pool, orderId))!;
    const [items, allocations, tasks, shipments, events, reservations] = await Promise.all([
      repo.listItems(this.pool, orderId),
      repo.listAllocations(this.pool, orderId),
      repo.listTasks(this.pool, orderId),
      repo.listShipments(this.pool, orderId),
      repo.listEvents(this.pool, orderId),
      repo.listOrderReservations(this.pool, orderId),
    ]);
    const internal = principal.role !== 'customer';
    const heldUntil = reservations
      .filter((reservation) => reservation.status === 'ACTIVE')
      .map((reservation) => reservation.expires_at)
      .sort((a, b) => a.getTime() - b.getTime())[0];
    return {
      order_id: order.order_id,
      status: order.status,
      review_reason: order.review_reason,
      fulfillable_qty: order.fulfillable_qty,
      early_shortage_detected: order.early_shortage_detected,
      sales_store_id: order.sales_store_id,
      site_id: order.site_id,
      requested_delivery_at: order.requested_delivery_at.toISOString(),
      inventory_as_of: order.inventory_as_of?.toISOString() ?? null,
      // From the reservations themselves, because renewal moves it after approval.
      reservation_expires_at: heldUntil?.toISOString() ?? null,
      eta: order.eta?.toISOString() ?? null,
      eta_is_estimate: true,
      at_risk: order.at_risk,
      at_risk_reason: order.at_risk_reason,
      approved_at: order.approved_at?.toISOString() ?? null,
      delivered_at: order.delivered_at?.toISOString() ?? null,
      otif: order.otif,
      version: order.version,
      created_at: order.created_at.toISOString(),
      items: items.map((item) => ({
        sku_id: item.sku_id,
        quantity: item.quantity,
        unit: item.unit,
        unit_price_sek: Number(item.unit_price),
      })),
      allocations: allocations.map((allocation) => ({
        node_id: allocation.node_id,
        sku_id: allocation.sku_id,
        quantity: allocation.quantity,
        reason: allocation.routing_reason,
      })),
      shipments: tasks
        .filter((task) => LIVE_TASK_STATUSES.includes(task.status))
        .map((task) => {
          const shipment = shipments.find((candidate) => candidate.task_id === task.task_id);
          return {
            task_id: task.task_id,
            node_id: task.node_id,
            status: task.status,
            task_version: task.version,
            dispatch_slot: shipment?.dispatch_slot?.toISOString() ?? null,
            eta: shipment?.eta?.toISOString() ?? null,
            eta_inputs: shipment?.eta_inputs ?? null,
            is_short: shipment?.is_short ?? false,
            dispatched_at: task.dispatched_at?.toISOString() ?? null,
            delivered_at: task.delivered_at?.toISOString() ?? null,
            delivered_qty: task.delivered_qty,
            reservation_health: reservationHealth(
              task.status,
              reservations.filter((reservation) => reservation.task_id === task.task_id),
            ),
          };
        }),
      events: events.map((event) => ({
        type: event.type,
        version: event.version,
        occurred_at: event.occurred_at.toISOString(),
        // Who did it and free-text reasons are internal.
        ...(internal ? { actor: event.actor, data: event.data } : {}),
      })),
    };
  }
}
