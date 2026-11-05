import type { FastifyBaseLogger } from 'fastify';
import type { Principal } from '../../auth.js';
import type { Config } from '../../config.js';
import { SourceRejectedError, SourceUnavailableError, type SimulatorClient } from '../../connectors/simulator.js';
import type { Db } from '../../db.js';
import { AppError } from '../../errors.js';
import { inTx } from '../../tx.js';
import type { EtaService } from '../eta/eta.service.js';
import type { InventoryService } from '../inventory/inventory.service.js';
import type { NotificationHub } from '../notifications/hub.js';
import * as orders from '../orders/orders.repository.js';
import { reservationHealth } from '../orders/orders.service.js';
import { assertTaskTransition } from '../orders/state-machine.js';
import type { AllocationService } from '../reservations/allocation.service.js';
import type { ReservationsService } from '../reservations/reservations.service.js';

export class TasksService {
  constructor(
    private readonly pool: Db,
    private readonly hub: NotificationHub,
    private readonly config: Config,
    private readonly simulator: SimulatorClient,
    private readonly inventory: InventoryService,
    private readonly reservations: ReservationsService,
    private readonly allocation: AllocationService,
    private readonly eta: EtaService,
    private readonly log: FastifyBaseLogger,
  ) {}

  /** The node comes from the token, never from the client. Staff act only on their own node's tasks. */
  private assertOwnNode(principal: Principal, nodeId: string): void {
    if (principal.role !== 'staff' || principal.store_id !== nodeId) {
      throw new AppError(403, 'FORBIDDEN', 'This task belongs to another node');
    }
  }

  async list(principal: Principal, status?: string) {
    const tasks = await orders.listTasksForStaff(this.pool, {
      ...(principal.role === 'staff' ? { nodeId: principal.store_id! } : {}),
      ...(status ? { status } : {}),
    });
    return Promise.all(
      tasks.map(async (task) => ({
        task_id: task.task_id,
        order_id: task.order_id,
        node_id: task.node_id,
        status: task.status,
        version: task.version,
        order_status: task.order_status,
        allocated_qty: task.allocated_qty,
        requested_delivery_at: task.requested_delivery_at.toISOString(),
        eta: task.order_eta?.toISOString() ?? null,
        at_risk: task.at_risk,
        reservation_health: reservationHealth(task.status, await orders.listTaskReservations(this.pool, task.task_id)),
        reject_reason: task.reject_reason,
        created_at: task.created_at.toISOString(),
      })),
    );
  }

  private async loadForAction(taskId: string, principal: Principal, version: number) {
    const task = await orders.getTask(this.pool, taskId);
    if (!task) throw new AppError(404, 'TASK_NOT_FOUND', 'Task not found');
    this.assertOwnNode(principal, task.node_id);
    if (task.version !== version) throw new AppError(409, 'VERSION_CONFLICT', 'Task was changed by someone else');
    return task;
  }

  private async result(taskId: string) {
    const task = (await orders.getTask(this.pool, taskId))!;
    const order = (await orders.getOrder(this.pool, task.order_id))!;
    return {
      task_id: task.task_id,
      status: task.status,
      version: task.version,
      node_id: task.node_id,
      order_id: order.order_id,
      order_status: order.status,
      order_version: order.version,
      eta: order.eta?.toISOString() ?? null,
      at_risk: order.at_risk,
    };
  }

  /**
   * Approves one node's part. The source is asked first, outside any transaction, whether the order's
   * reservations still hold; the order becomes APPROVED only when every live task is. Renewal starts
   * only then: until the last approval, the 30-minute deadline stands.
   */
  async approve(taskId: string, principal: Principal, version: number) {
    const task = await this.loadForAction(taskId, principal, version);
    assertTaskTransition(task.status, 'APPROVED');

    const validity = await this.reservations.verifyForApproval(task.order_id);
    if (validity === 'UNKNOWN') {
      throw new AppError(503, 'SOURCE_UNAVAILABLE', 'The source cannot confirm the reservation right now; try again');
    }
    if (validity === 'INVALID') {
      await this.reservations.expireOrder(task.order_id, principal.sub);
      throw new AppError(409, 'RESERVATION_EXPIRED', 'The reservation is no longer valid, so the order has expired');
    }

    const orderApproved = await inTx(this.pool, this.hub, async (tx) => {
      let order = await orders.lockOrder(tx.client, task.order_id);
      if (order.status !== 'AWAITING_APPROVAL') {
        throw new AppError(409, 'INVALID_TRANSITION', `Order is ${order.status}`);
      }
      const current = await orders.lockTask(tx.client, taskId);
      if (current.version !== version) throw new AppError(409, 'VERSION_CONFLICT', 'Task was changed by someone else');

      const now = new Date();
      ({ order } = await orders.transitionTask(tx, order, current, 'APPROVED', principal.sub, this.config.countryCode, {
        approved_by: principal.sub,
        approved_at: now,
      }));
      const tasks = await orders.listTasks(tx.client, task.order_id);
      const live = tasks.filter((candidate) => candidate.status === 'PENDING_APPROVAL' || candidate.status === 'APPROVED');
      order = await this.eta.refresh(tx, order, now);
      if (live.every((candidate) => candidate.status === 'APPROVED')) {
        await orders.transitionOrder(tx, order, 'APPROVED', principal.sub, this.config.countryCode, { approved_at: now });
        return true;
      }
      return false;
    });

    if (orderApproved) await this.reservations.renewOrder(task.order_id);
    return this.result(taskId);
  }

  /** Releases this node's stock and looks for the missing quantity elsewhere. */
  async reject(taskId: string, principal: Principal, version: number, reason: string) {
    const task = await this.loadForAction(taskId, principal, version);
    await this.releaseAndReroute(task, version, principal.sub, reason);
    return this.result(taskId);
  }

  /**
   * Circuit breaker: the node's server stopped reporting, so its unapproved part is moved to other nodes
   * the same way as a rejection. Returns false if the task was decided or the order moved on meanwhile.
   */
  async rerouteFromOfflineNode(taskId: string): Promise<boolean> {
    const task = await orders.getTask(this.pool, taskId);
    if (!task || task.status !== 'PENDING_APPROVAL') return false;
    const timeout = this.config.nodes.heartbeatTimeoutSeconds;
    const silence = timeout < 120 ? `${timeout} s` : `${Math.round(timeout / 60)} min`;
    try {
      await this.releaseAndReroute(
        task,
        task.version,
        'system',
        `No heartbeat from ${task.node_id} for over ${silence}; moved to another node`,
        { reason: 'NODE_OFFLINE' },
      );
      return true;
    } catch (error) {
      if (error instanceof AppError && error.statusCode === 409) return false;
      throw error;
    }
  }

  private async releaseAndReroute(
    task: orders.Task,
    version: number,
    actor: string,
    reason: string,
    publicData: Record<string, unknown> = {},
  ): Promise<void> {
    const taskId = task.task_id;
    assertTaskTransition(task.status, 'REJECTED');

    await inTx(this.pool, this.hub, async (tx) => {
      let order = await orders.lockOrder(tx.client, task.order_id);
      if (order.status !== 'AWAITING_APPROVAL') {
        throw new AppError(409, 'INVALID_TRANSITION', `Order is ${order.status}`);
      }
      const current = await orders.lockTask(tx.client, taskId);
      if (current.version !== version) throw new AppError(409, 'VERSION_CONFLICT', 'Task was changed by someone else');
      ({ order } = await orders.transitionTask(
        tx,
        order,
        current,
        'REJECTED',
        actor,
        this.config.countryCode,
        { reject_reason: reason },
        { reason },
        publicData,
      ));
      await orders.markReservationsReleasing(tx.client, { taskId });
      await orders.releaseAllocations(tx.client, { taskId });
      order = await orders.transitionOrder(tx, order, 'NEEDS_REALLOCATION', actor, this.config.countryCode);
    });
    await this.reservations.releaseQueued(task.order_id);

    await inTx(this.pool, this.hub, async (tx) => {
      const order = await orders.lockOrder(tx.client, task.order_id);
      if (order.status === 'NEEDS_REALLOCATION') {
        await orders.transitionOrder(tx, order, 'ALLOCATING', actor, this.config.countryCode);
      }
    });
    const after = (await orders.getOrder(this.pool, task.order_id))!;
    if (after.status === 'ALLOCATING') await this.allocation.allocate(task.order_id, actor);
  }

  /**
   * Commits the stock at the source, then records the dispatch. A commit is idempotent at the source, so
   * a retry after a failure in between is safe. If the source no longer holds the stock, nothing is
   * dispatched: the task stays APPROVED and shows the lost reservation.
   */
  async dispatch(taskId: string, principal: Principal, version: number) {
    const task = await this.loadForAction(taskId, principal, version);
    assertTaskTransition(task.status, 'DISPATCHED');
    const order = (await orders.getOrder(this.pool, task.order_id))!;
    if (order.status !== 'APPROVED' && order.status !== 'DISPATCHING') {
      throw new AppError(409, 'ORDER_NOT_APPROVED', `Order is ${order.status}; every node must approve first`);
    }

    const reservations = await orders.listTaskReservations(this.pool, taskId);
    const lost = () => new AppError(409, 'RESERVATION_LOST', 'The source no longer holds this stock; it cannot be dispatched');
    if (reservations.some((reservation) => reservation.status !== 'ACTIVE' && reservation.status !== 'COMMITTED')) {
      throw lost();
    }
    for (const reservation of reservations) {
      if (reservation.status === 'COMMITTED') continue;
      try {
        const committed = await this.simulator.commit(reservation.external_ref!);
        if (committed.inventory) await this.inventory.applySourceStock(committed.inventory);
        await orders.setReservationStatus(this.pool, reservation.reservation_id, 'COMMITTED');
      } catch (error) {
        if (error instanceof SourceUnavailableError) {
          throw new AppError(503, 'SOURCE_UNAVAILABLE', 'The source is unavailable, so nothing was dispatched; try again');
        }
        if (error instanceof SourceRejectedError) {
          await this.reservations.markLost(reservation, error.sourceStatus ?? error.code);
          throw lost();
        }
        throw error;
      }
    }

    await inTx(this.pool, this.hub, async (tx) => {
      let locked = await orders.lockOrder(tx.client, task.order_id);
      const current = await orders.lockTask(tx.client, taskId);
      if (current.version !== version) throw new AppError(409, 'VERSION_CONFLICT', 'Task was changed by someone else');
      ({ order: locked } = await orders.transitionTask(
        tx,
        locked,
        current,
        'DISPATCHED',
        principal.sub,
        this.config.countryCode,
        { dispatched_at: new Date() },
      ));
      if (locked.status === 'APPROVED') {
        locked = await orders.transitionOrder(tx, locked, 'DISPATCHING', principal.sub, this.config.countryCode);
      }
      const tasks = await orders.listTasks(tx.client, task.order_id);
      const live = tasks.filter((candidate) => ['APPROVED', 'DISPATCHED', 'DELIVERED'].includes(candidate.status));
      locked = await this.eta.refresh(tx, locked);
      if (live.every((candidate) => candidate.status !== 'APPROVED')) {
        await orders.transitionOrder(tx, locked, 'DISPATCHED', principal.sub, this.config.countryCode, {
          reservation_expires_at: null,
        });
      }
    });
    return this.result(taskId);
  }

  /** Proof of delivery. OTIF needs every shipment on time and in full. */
  async deliver(taskId: string, principal: Principal, version: number, deliveredQty: number, note?: string) {
    const task = await this.loadForAction(taskId, principal, version);
    assertTaskTransition(task.status, 'DELIVERED');
    const allocated = (await orders.listAllocations(this.pool, task.order_id))
      .filter((allocation) => allocation.task_id === taskId)
      .reduce((total, allocation) => total + allocation.quantity, 0);
    if (deliveredQty > allocated) {
      throw new AppError(422, 'INVALID_QUANTITY', `Delivered quantity is more than the ${allocated} allocated`);
    }

    await inTx(this.pool, this.hub, async (tx) => {
      let locked = await orders.lockOrder(tx.client, task.order_id);
      const current = await orders.lockTask(tx.client, taskId);
      if (current.version !== version) throw new AppError(409, 'VERSION_CONFLICT', 'Task was changed by someone else');
      const now = new Date();
      const isShort = deliveredQty < allocated;
      ({ order: locked } = await orders.transitionTask(
        tx,
        locked,
        current,
        'DELIVERED',
        principal.sub,
        this.config.countryCode,
        { delivered_at: now, delivered_qty: deliveredQty, delivery_note: note ?? null },
        { delivered_qty: deliveredQty, allocated_qty: allocated, short: isShort },
      ));
      await tx.client.query('UPDATE shipments SET is_short = $2, updated_at = now() WHERE task_id = $1', [taskId, isShort]);

      const shipments = await orders.listShipments(tx.client, task.order_id);
      const tasks = (await orders.listTasks(tx.client, task.order_id)).filter(
        (candidate) => candidate.status === 'DISPATCHED' || candidate.status === 'DELIVERED',
      );
      if (tasks.every((candidate) => candidate.status === 'DELIVERED') && locked.status === 'DISPATCHED') {
        const onTime = now.getTime() <= locked.requested_delivery_at.getTime();
        const inFull = tasks.every((candidate) => !shipments.find((s) => s.task_id === candidate.task_id)?.is_short);
        await orders.transitionOrder(
          tx,
          locked,
          'DELIVERED',
          principal.sub,
          this.config.countryCode,
          { delivered_at: now, otif: onTime && inFull },
          { on_time: onTime, in_full: inFull },
          { on_time: onTime, in_full: inFull },
        );
      }
    });
    this.log.info({ task_id: taskId }, 'delivery confirmed');
    return this.result(taskId);
  }
}
