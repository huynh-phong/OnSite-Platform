import type pg from 'pg';
import type { Db } from '../db.js';
import { withTransaction } from '../db.js';
import { SimError } from '../errors.js';
import { INVENTORY_COLUMNS, type LegacyInventory } from './catalog.js';
import { appendFeed } from './feed.js';

interface ReservationRow {
  id: string;
  node_id: string;
  sku_id: string;
  qty: number;
  status: 'ACTIVE' | 'COMMITTED' | 'RELEASED' | 'EXPIRED';
  expires_at: Date;
  idempotency_key: string;
  extension_count: number;
}

export interface ReservationResult {
  reservation_id: string;
  node_id: string;
  sku_id: string;
  qty: number;
  status: ReservationRow['status'];
  expires_at: string;
  extension_count: number;
  /** Stock row after this operation. Absent when the operation changed no stock. */
  inventory?: LegacyInventory;
}

function toResult(row: ReservationRow, inventory?: LegacyInventory): ReservationResult {
  return {
    reservation_id: row.id,
    node_id: row.node_id,
    sku_id: row.sku_id,
    qty: row.qty,
    status: row.status,
    expires_at: row.expires_at.toISOString(),
    extension_count: row.extension_count,
    ...(inventory ? { inventory } : {}),
  };
}

async function ledger(client: pg.PoolClient, row: ReservationRow, type: string): Promise<void> {
  await client.query(`INSERT INTO stock_ledger (node_id, sku_id, type, qty, reference) VALUES ($1, $2, $3, $4, $5)`, [
    row.node_id,
    row.sku_id,
    type,
    row.qty,
    row.id,
  ]);
}

async function lockReservation(client: pg.PoolClient, id: string): Promise<ReservationRow> {
  const { rows } = await client.query<ReservationRow>('SELECT * FROM reservations WHERE id = $1 FOR UPDATE', [id]);
  if (!rows[0]) throw new SimError(404, 'RESERVATION_NOT_FOUND', `Reservation ${id} not found`);
  return rows[0];
}

/** Gives the held quantity back and closes the reservation. The row must be locked and ACTIVE. */
async function closeHeld(
  client: pg.PoolClient,
  row: ReservationRow,
  status: 'RELEASED' | 'EXPIRED',
): Promise<LegacyInventory> {
  const inventory = await client.query<LegacyInventory>(
    `UPDATE inventory SET reserved = reserved - $3, version = version + 1, updated_at = now()
      WHERE node_id = $1 AND sku_id = $2 RETURNING ${INVENTORY_COLUMNS}`,
    [row.node_id, row.sku_id, row.qty],
  );
  await client.query('UPDATE reservations SET status = $2, updated_at = now() WHERE id = $1', [row.id, status]);
  await ledger(client, row, status === 'RELEASED' ? 'RELEASE' : 'EXPIRE');
  await appendFeed(client, 'inventory', `${row.node_id}:${row.sku_id}`);
  row.status = status;
  return inventory.rows[0]!;
}

function notActive(row: ReservationRow): SimError {
  return new SimError(409, 'RESERVATION_NOT_ACTIVE', `Reservation is ${row.status}`, { status: row.status });
}

export interface NewReservation {
  node_id: string;
  sku_id: string;
  qty: number;
  ttl_minutes: number;
  idempotency_key: string;
}

async function findByKey(pool: Db, input: NewReservation): Promise<ReservationResult | undefined> {
  const { rows } = await pool.query<ReservationRow>('SELECT * FROM reservations WHERE idempotency_key = $1', [
    input.idempotency_key,
  ]);
  const row = rows[0];
  if (!row) return undefined;
  if (row.node_id !== input.node_id || row.sku_id !== input.sku_id || row.qty !== input.qty) {
    throw new SimError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency key was used with a different request');
  }
  return toResult(row);
}

export async function createReservation(
  pool: Db,
  input: NewReservation,
): Promise<{ created: boolean; result: ReservationResult }> {
  const existing = await findByKey(pool, input);
  if (existing) return { created: false, result: existing };

  try {
    const result = await withTransaction(pool, async (client) => {
      // The check and the increment are one statement, so concurrent callers cannot oversell.
      const updated = await client.query<LegacyInventory>(
        `UPDATE inventory
            SET reserved = reserved + $3, version = version + 1, updated_at = now()
          WHERE node_id = $1 AND sku_id = $2
            AND on_hand - reserved - CEIL(on_hand * 0.10) >= $3
          RETURNING ${INVENTORY_COLUMNS}`,
        [input.node_id, input.sku_id, input.qty],
      );
      if (!updated.rows[0]) {
        const exists = await client.query('SELECT 1 FROM inventory WHERE node_id = $1 AND sku_id = $2', [
          input.node_id,
          input.sku_id,
        ]);
        if (!exists.rowCount) throw new SimError(404, 'UNKNOWN_STOCK_ROW', 'Unknown node or SKU');
        throw new SimError(409, 'INSUFFICIENT_STOCK', 'Not enough usable stock');
      }
      const inserted = await client.query<ReservationRow>(
        `INSERT INTO reservations (node_id, sku_id, qty, expires_at, idempotency_key)
         VALUES ($1, $2, $3, now() + make_interval(secs => $4), $5) RETURNING *`,
        [input.node_id, input.sku_id, input.qty, input.ttl_minutes * 60, input.idempotency_key],
      );
      const row = inserted.rows[0]!;
      await ledger(client, row, 'RESERVE');
      await appendFeed(client, 'inventory', `${input.node_id}:${input.sku_id}`);
      return toResult(row, updated.rows[0]);
    });
    return { created: true, result };
  } catch (error) {
    // A concurrent call with the same key won; its transaction committed and ours rolled back.
    if ((error as { code?: string }).code === '23505') {
      const winner = await findByKey(pool, input);
      if (winner) return { created: false, result: winner };
    }
    throw error;
  }
}

export async function getReservation(pool: Db, id: string): Promise<ReservationResult> {
  const { rows } = await pool.query<ReservationRow>('SELECT * FROM reservations WHERE id = $1', [id]);
  if (!rows[0]) throw new SimError(404, 'RESERVATION_NOT_FOUND', `Reservation ${id} not found`);
  const row = rows[0];
  // A reservation past its time is not valid even if the sweep has not reached it yet.
  if (row.status === 'ACTIVE' && row.expires_at.getTime() <= Date.now()) row.status = 'EXPIRED';
  return toResult(row);
}

/** on_hand and reserved both drop by the quantity. Repeating a commit returns the same result. */
export async function commitReservation(pool: Db, id: string): Promise<ReservationResult> {
  const outcome = await withTransaction(pool, async (client) => {
    const row = await lockReservation(client, id);
    if (row.status === 'COMMITTED') return { result: toResult(row) };
    if (row.status === 'ACTIVE' && row.expires_at.getTime() <= Date.now()) {
      await closeHeld(client, row, 'EXPIRED');
      return { rejected: notActive(row) };
    }
    if (row.status !== 'ACTIVE') return { rejected: notActive(row) };
    const inventory = await client.query<LegacyInventory>(
      `UPDATE inventory
          SET on_hand = on_hand - $3, reserved = reserved - $3, version = version + 1, updated_at = now()
        WHERE node_id = $1 AND sku_id = $2 RETURNING ${INVENTORY_COLUMNS}`,
      [row.node_id, row.sku_id, row.qty],
    );
    await client.query(`UPDATE reservations SET status = 'COMMITTED', updated_at = now() WHERE id = $1`, [id]);
    await ledger(client, row, 'OUTBOUND');
    await appendFeed(client, 'inventory', `${row.node_id}:${row.sku_id}`);
    row.status = 'COMMITTED';
    return { result: toResult(row, inventory.rows[0]) };
  });
  // Thrown after commit, so that an expiry found on the way is kept.
  if (outcome.rejected) throw outcome.rejected;
  return outcome.result!;
}

/** Releasing is idempotent: released and expired reservations hold nothing, so they report their state. */
export async function releaseReservation(pool: Db, id: string): Promise<ReservationResult> {
  return withTransaction(pool, async (client) => {
    const row = await lockReservation(client, id);
    if (row.status === 'COMMITTED') throw notActive(row);
    if (row.status !== 'ACTIVE') return toResult(row);
    const inventory = await closeHeld(client, row, 'RELEASED');
    return toResult(row, inventory);
  });
}

/** Releases by client key, for a create whose response was lost. A key that never arrived is not an error. */
export async function releaseByKey(pool: Db, key: string): Promise<{ status: string; inventory?: LegacyInventory }> {
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM reservations WHERE idempotency_key = $1', [key]);
  if (!rows[0]) return { status: 'NOT_FOUND' };
  return releaseReservation(pool, rows[0].id);
}

/**
 * Renews an active, unexpired reservation. It never touches stock, so repeats and concurrent calls are
 * safe, and GREATEST means a retry can never shorten a reservation.
 */
export async function extendReservation(pool: Db, id: string, ttlMinutes: number): Promise<ReservationResult> {
  const outcome = await withTransaction(pool, async (client) => {
    const row = await lockReservation(client, id);
    if (row.status === 'ACTIVE' && row.expires_at.getTime() <= Date.now()) {
      await closeHeld(client, row, 'EXPIRED');
      return { rejected: notActive(row) };
    }
    if (row.status !== 'ACTIVE') return { rejected: notActive(row) };
    const { rows } = await client.query<ReservationRow>(
      `UPDATE reservations
          SET expires_at = GREATEST(expires_at, now() + make_interval(secs => $2)),
              extended_at = now(), extension_count = extension_count + 1, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [id, ttlMinutes * 60],
    );
    return { result: toResult(rows[0]!) };
  });
  if (outcome.rejected) throw outcome.rejected;
  return outcome.result!;
}

/** Expires overdue reservations one transaction at a time and returns how many it closed. */
export async function sweepExpiredReservations(pool: Db): Promise<number> {
  let closed = 0;
  for (;;) {
    const found = await withTransaction(pool, async (client) => {
      const { rows } = await client.query<ReservationRow>(
        `SELECT * FROM reservations WHERE status = 'ACTIVE' AND expires_at <= now()
          ORDER BY expires_at LIMIT 1 FOR UPDATE SKIP LOCKED`,
      );
      if (!rows[0]) return false;
      await closeHeld(client, rows[0], 'EXPIRED');
      return true;
    });
    if (!found) return closed;
    closed += 1;
  }
}
