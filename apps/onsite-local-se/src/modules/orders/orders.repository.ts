import type pg from 'pg';
import type { Db } from '../../db.js';
import { AppError } from '../../errors.js';
import type { Tx } from '../../tx.js';
import { assertOrderTransition, assertTaskTransition, type OrderStatus, type TaskStatus } from './state-machine.js';

type Queryable = Pick<Db, 'query'>;

export interface Order {
  order_id: string;
  customer_id: string;
  sales_store_id: string;
  site_id: string;
  requested_delivery_at: Date;
  status: OrderStatus;
  review_reason: string | null;
  fulfillable_qty: number | null;
  early_shortage_detected: boolean;
  inventory_as_of: Date | null;
  reservation_expires_at: Date | null;
  eta: Date | null;
  at_risk: boolean;
  at_risk_reason: string | null;
  approved_at: Date | null;
  delivered_at: Date | null;
  otif: boolean | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

export interface Item {
  item_id: string;
  order_id: string;
  sku_id: string;
  quantity: number;
  unit: string;
  unit_price: string;
}

export interface Allocation {
  allocation_id: string;
  item_id: string;
  task_id: string | null;
  node_id: string;
  quantity: number;
  routing_reason: string;
  status: 'ACTIVE' | 'RELEASED';
  sku_id: string;
}

export interface Task {
  task_id: string;
  order_id: string;
  node_id: string;
  status: TaskStatus;
  approved_by: string | null;
  approved_at: Date | null;
  dispatched_at: Date | null;
  delivered_at: Date | null;
  delivered_qty: number | null;
  delivery_note: string | null;
  reject_reason: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

export interface Reservation {
  reservation_id: string;
  allocation_id: string;
  external_ref: string | null;
  status: 'PENDING' | 'ACTIVE' | 'RELEASING' | 'COMMITTED' | 'RELEASED' | 'EXPIRED';
  expires_at: Date;
  idempotency_key: string | null;
  last_renewed_at: Date | null;
  renewal_attempts: number;
  renewal_error: string | null;
  renewal_failed_at: Date | null;
  node_id: string;
  sku_id: string;
  quantity: number;
  task_id: string | null;
  order_id: string;
}

const RESERVATION_SELECT = `
  SELECT r.*, a.node_id, a.quantity, a.task_id, i.sku_id, i.order_id
    FROM reservations r
    JOIN allocations a USING (allocation_id)
    JOIN order_items i USING (item_id)`;

export async function nextOrderId(client: pg.PoolClient): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT 'SE-ORD-' || lpad(nextval('order_number_seq')::text, 6, '0') AS id`,
  );
  return rows[0]!.id;
}

export async function getOrder(db: Queryable, orderId: string): Promise<Order | undefined> {
  const { rows } = await db.query<Order>('SELECT * FROM orders WHERE order_id = $1', [orderId]);
  return rows[0];
}

export async function lockOrder(client: pg.PoolClient, orderId: string): Promise<Order> {
  const { rows } = await client.query<Order>('SELECT * FROM orders WHERE order_id = $1 FOR UPDATE', [orderId]);
  if (!rows[0]) throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found');
  return rows[0];
}

export async function insertOrder(
  client: pg.PoolClient,
  order: {
    order_id: string;
    customer_id: string;
    sales_store_id: string;
    site_id: string;
    requested_delivery_at: string;
  },
): Promise<Order> {
  const { rows } = await client.query<Order>(
    `INSERT INTO orders (order_id, customer_id, sales_store_id, site_id, requested_delivery_at, status)
     VALUES ($1, $2, $3, $4, $5, 'SUBMITTED') RETURNING *`,
    [order.order_id, order.customer_id, order.sales_store_id, order.site_id, order.requested_delivery_at],
  );
  return rows[0]!;
}

export async function insertItem(
  client: pg.PoolClient,
  item: { order_id: string; sku_id: string; quantity: number; unit: string; unit_price: string },
): Promise<Item> {
  const { rows } = await client.query<Item>(
    `INSERT INTO order_items (order_id, sku_id, quantity, unit, unit_price) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [item.order_id, item.sku_id, item.quantity, item.unit, item.unit_price],
  );
  return rows[0]!;
}

export async function listItems(db: Queryable, orderId: string): Promise<Item[]> {
  const { rows } = await db.query<Item>('SELECT * FROM order_items WHERE order_id = $1 ORDER BY sku_id, item_id', [
    orderId,
  ]);
  return rows;
}

export async function listAllocations(db: Queryable, orderId: string, activeOnly = true): Promise<Allocation[]> {
  const { rows } = await db.query<Allocation>(
    `SELECT a.*, i.sku_id FROM allocations a JOIN order_items i USING (item_id)
      WHERE i.order_id = $1 AND ($2 = FALSE OR a.status = 'ACTIVE')
      ORDER BY a.created_at, a.allocation_id`,
    [orderId, activeOnly],
  );
  return rows;
}

export async function listTasks(db: Queryable, orderId: string): Promise<Task[]> {
  const { rows } = await db.query<Task>('SELECT * FROM fulfilment_tasks WHERE order_id = $1 ORDER BY created_at, task_id', [
    orderId,
  ]);
  return rows;
}

export async function getTask(db: Queryable, taskId: string): Promise<Task | undefined> {
  const { rows } = await db.query<Task>('SELECT * FROM fulfilment_tasks WHERE task_id = $1', [taskId]);
  return rows[0];
}

export async function lockTask(client: pg.PoolClient, taskId: string): Promise<Task> {
  const { rows } = await client.query<Task>('SELECT * FROM fulfilment_tasks WHERE task_id = $1 FOR UPDATE', [taskId]);
  if (!rows[0]) throw new AppError(404, 'TASK_NOT_FOUND', 'Task not found');
  return rows[0];
}

export async function listOrderReservations(db: Queryable, orderId: string): Promise<Reservation[]> {
  const { rows } = await db.query<Reservation>(`${RESERVATION_SELECT} WHERE i.order_id = $1 ORDER BY r.created_at`, [
    orderId,
  ]);
  return rows;
}

export async function listTaskReservations(db: Queryable, taskId: string): Promise<Reservation[]> {
  const { rows } = await db.query<Reservation>(
    `${RESERVATION_SELECT} WHERE a.task_id = $1 AND a.status = 'ACTIVE' ORDER BY r.created_at`,
    [taskId],
  );
  return rows;
}

export async function listReleasing(db: Queryable, orderId?: string): Promise<Reservation[]> {
  const { rows } = await db.query<Reservation>(
    `${RESERVATION_SELECT} WHERE r.status = 'RELEASING' AND ($1::text IS NULL OR i.order_id = $1) ORDER BY r.created_at`,
    [orderId ?? null],
  );
  return rows;
}

/** Approved reservations about to run out. Orders still awaiting approval are never included. */
export async function listRenewalDue(db: Queryable, withinMinutes: number, orderId?: string): Promise<Reservation[]> {
  const { rows } = await db.query<Reservation>(
    `${RESERVATION_SELECT}
       JOIN fulfilment_tasks t ON t.task_id = a.task_id
       JOIN orders o ON o.order_id = i.order_id
      WHERE r.status = 'ACTIVE' AND t.status = 'APPROVED' AND o.status IN ('APPROVED', 'DISPATCHING')
        AND ($2::text IS NOT NULL OR r.expires_at <= now() + make_interval(mins => $1))
        AND ($2::text IS NULL OR i.order_id = $2)
      ORDER BY r.expires_at`,
    [withinMinutes, orderId ?? null],
  );
  return rows;
}

export async function listExpiredOrderIds(db: Queryable): Promise<string[]> {
  const { rows } = await db.query<{ order_id: string }>(
    `SELECT DISTINCT i.order_id
       FROM reservations r
       JOIN allocations a USING (allocation_id)
       JOIN order_items i USING (item_id)
       JOIN orders o ON o.order_id = i.order_id
      WHERE r.status = 'ACTIVE' AND r.expires_at <= now() AND o.status = 'AWAITING_APPROVAL'`,
  );
  return rows.map((row) => row.order_id);
}

export async function listInterruptedOrderIds(db: Queryable, olderThanSeconds: number): Promise<string[]> {
  const { rows } = await db.query<{ order_id: string }>(
    `SELECT order_id FROM orders
      WHERE status IN ('SUBMITTED', 'ALLOCATING', 'NEEDS_REALLOCATION')
        AND updated_at < now() - make_interval(secs => $1)`,
    [olderThanSeconds],
  );
  return rows.map((row) => row.order_id);
}

export async function listOpenOrderIds(db: Queryable): Promise<string[]> {
  const { rows } = await db.query<{ order_id: string }>(
    `SELECT order_id FROM orders WHERE status IN ('AWAITING_APPROVAL', 'APPROVED', 'DISPATCHING', 'DISPATCHED')`,
  );
  return rows.map((row) => row.order_id);
}

/** Marks a release as decided. It stays RELEASING until the source confirms it. */
export async function markReservationsReleasing(
  client: pg.PoolClient,
  filter: { orderId?: string; taskId?: string; allocationIds?: string[] },
): Promise<void> {
  await client.query(
    `UPDATE reservations SET status = 'RELEASING', updated_at = now()
      WHERE status IN ('PENDING', 'ACTIVE') AND allocation_id IN (
        SELECT a.allocation_id FROM allocations a JOIN order_items i USING (item_id)
         WHERE ($1::text IS NULL OR i.order_id = $1)
           AND ($2::uuid IS NULL OR a.task_id = $2)
           AND ($3::uuid[] IS NULL OR a.allocation_id = ANY($3)))`,
    [filter.orderId ?? null, filter.taskId ?? null, filter.allocationIds ?? null],
  );
}

export async function releaseAllocations(
  client: pg.PoolClient,
  filter: { orderId?: string; taskId?: string; allocationIds?: string[] },
): Promise<void> {
  await client.query(
    `UPDATE allocations a SET status = 'RELEASED'
       FROM order_items i
      WHERE a.item_id = i.item_id AND a.status = 'ACTIVE'
        AND ($1::text IS NULL OR i.order_id = $1)
        AND ($2::uuid IS NULL OR a.task_id = $2)
        AND ($3::uuid[] IS NULL OR a.allocation_id = ANY($3))`,
    [filter.orderId ?? null, filter.taskId ?? null, filter.allocationIds ?? null],
  );
}

export async function insertAllocation(
  client: pg.PoolClient,
  allocation: { allocation_id: string; item_id: string; node_id: string; quantity: number; routing_reason: string },
): Promise<void> {
  await client.query(
    `INSERT INTO allocations (allocation_id, item_id, node_id, quantity, routing_reason, created_at)
     VALUES ($1, $2, $3, $4, $5, clock_timestamp())`,
    [allocation.allocation_id, allocation.item_id, allocation.node_id, allocation.quantity, allocation.routing_reason],
  );
}

export async function insertReservationIntent(
  client: pg.PoolClient,
  input: { allocationId: string; key: string; ttlMinutes: number },
): Promise<string> {
  const { rows } = await client.query<{ reservation_id: string }>(
    `INSERT INTO reservations (allocation_id, status, expires_at, idempotency_key)
     VALUES ($1, 'PENDING', now() + make_interval(secs => $2), $3) RETURNING reservation_id`,
    [input.allocationId, input.ttlMinutes * 60, input.key],
  );
  return rows[0]!.reservation_id;
}

/** Records the source's confirmation. A release decided in the meantime stays decided. */
export async function confirmReservation(
  db: Queryable,
  reservationId: string,
  externalRef: string,
  expiresAt: string,
): Promise<'ACTIVE' | 'RELEASING' | 'RELEASED'> {
  const { rows } = await db.query<{ status: 'ACTIVE' | 'RELEASING' | 'RELEASED' }>(
    `UPDATE reservations
        SET external_ref = $2, expires_at = $3, updated_at = now(),
            status = CASE WHEN status = 'PENDING' THEN 'ACTIVE'
                          WHEN status = 'RELEASED' THEN 'RELEASING' ELSE status END
      WHERE reservation_id = $1 RETURNING status`,
    [reservationId, externalRef, expiresAt],
  );
  return rows[0]!.status;
}

export async function setReservationStatus(db: Queryable, reservationId: string, status: Reservation['status']) {
  await db.query('UPDATE reservations SET status = $2, updated_at = now() WHERE reservation_id = $1', [
    reservationId,
    status,
  ]);
}

export async function recordRenewal(db: Queryable, reservationId: string, expiresAt: string) {
  await db.query(
    `UPDATE reservations
        SET expires_at = GREATEST(expires_at, $2::timestamptz), last_renewed_at = now(), renewal_attempts = 0,
            renewal_error = NULL, renewal_failed_at = NULL, updated_at = now()
      WHERE reservation_id = $1 AND status = 'ACTIVE'`,
    [reservationId, expiresAt],
  );
}

export async function recordRenewalFailure(db: Queryable, reservationId: string, error: string) {
  await db.query(
    `UPDATE reservations
        SET renewal_attempts = renewal_attempts + 1, renewal_error = $2,
            renewal_failed_at = COALESCE(renewal_failed_at, now()), updated_at = now()
      WHERE reservation_id = $1 AND status = 'ACTIVE'`,
    [reservationId, error],
  );
}

export async function recordReservationLost(client: pg.PoolClient, reservationId: string, error: string) {
  const { rowCount } = await client.query(
    `UPDATE reservations
        SET status = 'EXPIRED', renewal_error = $2, renewal_failed_at = COALESCE(renewal_failed_at, now()),
            updated_at = now()
      WHERE reservation_id = $1 AND status = 'ACTIVE'`,
    [reservationId, error],
  );
  return (rowCount ?? 0) > 0;
}

export async function earliestActiveExpiry(client: pg.PoolClient, orderId: string): Promise<Date | null> {
  const { rows } = await client.query<{ expires_at: Date | null }>(
    `SELECT min(r.expires_at) AS expires_at
       FROM reservations r JOIN allocations a USING (allocation_id) JOIN order_items i USING (item_id)
      WHERE i.order_id = $1 AND r.status = 'ACTIVE'`,
    [orderId],
  );
  return rows[0]?.expires_at ?? null;
}

/** Fields of an order payload that may leave Local SE. There is no PII here, by construction. */
function outboxPayload(order: Order, counts: { lines: number; shipments: number }, extra: Record<string, unknown>) {
  return {
    status: order.status,
    sales_store_id: order.sales_store_id,
    shipment_count: counts.shipments,
    line_count: counts.lines,
    at_risk: order.at_risk,
    early_shortage_detected: order.early_shortage_detected,
    otif: order.otif,
    eta: order.eta?.toISOString() ?? null,
    requested_delivery_at: order.requested_delivery_at.toISOString(),
    created_at: order.created_at.toISOString(),
    ...extra,
  };
}

/**
 * The one way an order changes: optimistic version check, then the order event and the outbox row in
 * the same transaction. publicData goes to the outbox and must contain only codes and identifiers.
 */
export async function changeOrder(
  tx: Tx,
  order: Order,
  patch: Partial<Order>,
  event: { type: string; actor: string; data?: Record<string, unknown>; publicData?: Record<string, unknown> },
  countryCode: string,
): Promise<Order> {
  const columns = Object.keys(patch);
  const assignments = columns.map((column, index) => `${column} = $${index + 3}`);
  const { rows } = await tx.client.query<Order>(
    `UPDATE orders SET ${[...assignments, 'version = version + 1', 'updated_at = now()'].join(', ')}
      WHERE order_id = $1 AND version = $2 RETURNING *`,
    [order.order_id, order.version, ...columns.map((column) => patch[column as keyof Order])],
  );
  const updated = rows[0];
  if (!updated) throw new AppError(409, 'VERSION_CONFLICT', 'Order was changed by someone else');

  await tx.client.query(`INSERT INTO order_events (order_id, version, type, actor, data) VALUES ($1, $2, $3, $4, $5)`, [
    updated.order_id,
    updated.version,
    event.type,
    event.actor,
    JSON.stringify(event.data ?? {}),
  ]);
  const counts = await tx.client.query<{ lines: number; shipments: number }>(
    `SELECT (SELECT count(*)::int FROM order_items WHERE order_id = $1) AS lines,
            (SELECT count(*)::int FROM fulfilment_tasks
              WHERE order_id = $1 AND status NOT IN ('REJECTED', 'EXPIRED', 'CANCELLED')) AS shipments`,
    [updated.order_id],
  );
  await tx.client.query(
    `INSERT INTO outbox_events (origin_country, aggregate_type, aggregate_id, aggregate_version, event_type, payload)
     VALUES ($1, 'order', $2, $3, $4, $5)`,
    [
      countryCode,
      updated.order_id,
      updated.version,
      `${event.type}.v1`,
      JSON.stringify(outboxPayload(updated, counts.rows[0]!, event.publicData ?? {})),
    ],
  );
  return updated;
}

export async function transitionOrder(
  tx: Tx,
  order: Order,
  to: OrderStatus,
  actor: string,
  countryCode: string,
  patch: Partial<Order> = {},
  data: Record<string, unknown> = {},
  publicData: Record<string, unknown> = {},
): Promise<Order> {
  assertOrderTransition(order.status, to);
  const updated = await changeOrder(
    tx,
    order,
    { ...patch, status: to },
    { type: `order.${to.toLowerCase()}`, actor, data: { from: order.status, ...data }, publicData },
    countryCode,
  );
  const tasks = await listTasks(tx.client, order.order_id);
  tx.notify({
    type: 'order.updated',
    scope: { customerId: order.customer_id, nodeIds: tasks.map((task) => task.node_id) },
    data: { order_id: order.order_id, status: to, version: updated.version },
  });
  return updated;
}

/** Task changes carry their own version check and also advance the parent order's history. */
export async function transitionTask(
  tx: Tx,
  order: Order,
  task: Task,
  to: TaskStatus,
  actor: string,
  countryCode: string,
  patch: Partial<Task> = {},
  data: Record<string, unknown> = {},
): Promise<{ order: Order; task: Task }> {
  assertTaskTransition(task.status, to);
  const merged: Partial<Task> = { ...patch, status: to };
  const columns = Object.keys(merged);
  const assignments = columns.map((column, index) => `${column} = $${index + 3}`);
  const { rows } = await tx.client.query<Task>(
    `UPDATE fulfilment_tasks SET ${[...assignments, 'version = version + 1', 'updated_at = now()'].join(', ')}
      WHERE task_id = $1 AND version = $2 RETURNING *`,
    [task.task_id, task.version, ...columns.map((column) => merged[column as keyof Task])],
  );
  const updated = rows[0];
  if (!updated) throw new AppError(409, 'VERSION_CONFLICT', 'Task was changed by someone else');
  const updatedOrder = await changeOrder(
    tx,
    order,
    {},
    {
      type: `task.${to.toLowerCase()}`,
      actor,
      data: { task_id: task.task_id, node_id: task.node_id, from: task.status, ...data },
      publicData: { node_id: task.node_id, task_status: to },
    },
    countryCode,
  );
  tx.notify({
    type: 'task.updated',
    scope: { nodeIds: [task.node_id] },
    data: { task_id: task.task_id, order_id: task.order_id, status: to, version: updated.version },
  });
  return { order: updatedOrder, task: updated };
}

export async function createTask(tx: Tx, orderId: string, nodeId: string): Promise<Task> {
  const { rows } = await tx.client.query<Task>(
    `INSERT INTO fulfilment_tasks (order_id, node_id, created_at) VALUES ($1, $2, clock_timestamp()) RETURNING *`,
    [orderId, nodeId],
  );
  await tx.client.query('INSERT INTO shipments (task_id) VALUES ($1)', [rows[0]!.task_id]);
  return rows[0]!;
}

export async function bumpTaskVersion(client: pg.PoolClient, taskId: string): Promise<void> {
  await client.query('UPDATE fulfilment_tasks SET version = version + 1, updated_at = now() WHERE task_id = $1', [
    taskId,
  ]);
}

export async function assignAllocations(client: pg.PoolClient, taskId: string, allocationIds: string[]) {
  await client.query('UPDATE allocations SET task_id = $1 WHERE allocation_id = ANY($2)', [taskId, allocationIds]);
}

// ---------------------------------------------------------------- idempotency

export interface IdempotencyRecord {
  request_hash: string;
  status_code: number | null;
  response: unknown;
  order_id: string | null;
  created_at: Date;
}

/** Returns undefined when this call now owns the key, otherwise the record that already exists. */
export async function claimIdempotencyKey(
  client: pg.PoolClient,
  principalId: string,
  key: string,
  requestHash: string,
): Promise<IdempotencyRecord | undefined> {
  const inserted = await client.query(
    `INSERT INTO idempotency_records (principal_id, key, request_hash, expires_at)
     VALUES ($1, $2, $3, now() + interval '24 hours')
     ON CONFLICT (principal_id, key) DO NOTHING`,
    [principalId, key, requestHash],
  );
  if (inserted.rowCount) return undefined;
  const { rows } = await client.query<IdempotencyRecord>(
    `SELECT request_hash, status_code, response, order_id, created_at
       FROM idempotency_records WHERE principal_id = $1 AND key = $2`,
    [principalId, key],
  );
  return rows[0];
}

export async function findIdempotencyRecord(
  db: Queryable,
  principalId: string,
  key: string,
): Promise<IdempotencyRecord | undefined> {
  const { rows } = await db.query<IdempotencyRecord>(
    `SELECT request_hash, status_code, response, order_id, created_at
       FROM idempotency_records WHERE principal_id = $1 AND key = $2`,
    [principalId, key],
  );
  return rows[0];
}

export async function linkIdempotencyOrder(client: pg.PoolClient, principalId: string, key: string, orderId: string) {
  await client.query('UPDATE idempotency_records SET order_id = $3 WHERE principal_id = $1 AND key = $2', [
    principalId,
    key,
    orderId,
  ]);
}

export async function storeIdempotencyResponse(
  db: Queryable,
  principalId: string,
  key: string,
  statusCode: number,
  response: unknown,
) {
  await db.query('UPDATE idempotency_records SET status_code = $3, response = $4 WHERE principal_id = $1 AND key = $2', [
    principalId,
    key,
    statusCode,
    JSON.stringify(response),
  ]);
}

export async function purgeExpiredIdempotency(db: Queryable): Promise<void> {
  await db.query('DELETE FROM idempotency_records WHERE expires_at < now()');
}

// ---------------------------------------------------------------- reads for views

export async function listEvents(db: Queryable, orderId: string) {
  const { rows } = await db.query<{
    type: string;
    version: number;
    actor: string;
    occurred_at: Date;
    data: Record<string, unknown>;
  }>('SELECT type, version, actor, occurred_at, data FROM order_events WHERE order_id = $1 ORDER BY order_event_id', [
    orderId,
  ]);
  return rows;
}

export interface ShipmentRow {
  shipment_id: string;
  task_id: string;
  dispatch_slot: Date | null;
  eta: Date | null;
  eta_inputs: unknown;
  is_short: boolean;
}

export async function listShipments(db: Queryable, orderId: string): Promise<ShipmentRow[]> {
  const { rows } = await db.query<ShipmentRow>(
    `SELECT s.shipment_id, s.task_id, s.dispatch_slot, s.eta, s.eta_inputs, s.is_short
       FROM shipments s JOIN fulfilment_tasks t USING (task_id) WHERE t.order_id = $1`,
    [orderId],
  );
  return rows;
}

export async function listOrders(
  db: Queryable,
  filter: { customerId?: string; nodeId?: string; status?: string; limit: number },
): Promise<Order[]> {
  const { rows } = await db.query<Order>(
    `SELECT o.* FROM orders o
      WHERE ($1::text IS NULL OR o.customer_id = $1)
        AND ($2::text IS NULL OR EXISTS (SELECT 1 FROM fulfilment_tasks t WHERE t.order_id = o.order_id AND t.node_id = $2))
        AND ($3::text IS NULL OR o.status = $3)
      ORDER BY o.created_at DESC, o.order_id DESC LIMIT $4`,
    [filter.customerId ?? null, filter.nodeId ?? null, filter.status ?? null, filter.limit],
  );
  return rows;
}

export async function listTasksForStaff(db: Queryable, filter: { nodeId?: string; status?: string }) {
  const { rows } = await db.query<Task & { requested_delivery_at: Date; order_status: string; order_eta: Date | null; at_risk: boolean; allocated_qty: number }>(
    `SELECT t.*, o.requested_delivery_at, o.status AS order_status, o.eta AS order_eta, o.at_risk,
            COALESCE((SELECT sum(a.quantity)::int FROM allocations a WHERE a.task_id = t.task_id AND a.status = 'ACTIVE'), 0) AS allocated_qty
       FROM fulfilment_tasks t JOIN orders o USING (order_id)
      WHERE ($1::text IS NULL OR t.node_id = $1) AND ($2::text IS NULL OR t.status = $2)
      ORDER BY t.created_at, t.task_id`,
    [filter.nodeId ?? null, filter.status ?? null],
  );
  return rows;
}
