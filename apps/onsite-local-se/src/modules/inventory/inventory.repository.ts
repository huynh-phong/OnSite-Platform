import type pg from 'pg';
import type { SourceInventory } from '../../connectors/simulator.js';
import type { Db } from '../../db.js';
import type { CursorState } from './freshness.js';

type Queryable = Pick<Db, 'query'>;

export type SyncStream = 'products' | 'inventory';

export interface CursorRow extends CursorState {
  feedEpoch: string | null;
  sourceHeadSeq: number | null;
  lastAttemptAt: Date | null;
  consecutiveFailures: number;
}

interface RawCursor {
  last_seq: string;
  last_attempt_at: Date | null;
  last_successful_sync_at: Date | null;
  last_error: string | null;
  feed_epoch: string | null;
  source_head_seq: string | null;
  continuity_ok: boolean;
  consecutive_failures: number;
}

function toCursor(row: RawCursor): CursorRow {
  return {
    lastSeq: Number(row.last_seq),
    lastAttemptAt: row.last_attempt_at,
    lastSuccessfulSyncAt: row.last_successful_sync_at,
    lastError: row.last_error,
    feedEpoch: row.feed_epoch,
    sourceHeadSeq: row.source_head_seq === null ? null : Number(row.source_head_seq),
    continuityOk: row.continuity_ok,
    consecutiveFailures: row.consecutive_failures,
  };
}

export async function getCursor(db: Queryable, source: string, stream: SyncStream): Promise<CursorRow | null> {
  const { rows } = await db.query<RawCursor>('SELECT * FROM sync_cursors WHERE source_system = $1 AND stream = $2', [
    source,
    stream,
  ]);
  return rows[0] ? toCursor(rows[0]) : null;
}

export async function ensureCursor(db: Queryable, source: string, stream: SyncStream): Promise<CursorRow> {
  await db.query(
    `INSERT INTO sync_cursors (source_system, stream) VALUES ($1, $2) ON CONFLICT (source_system, stream) DO NOTHING`,
    [source, stream],
  );
  return (await getCursor(db, source, stream))!;
}

export async function lockCursor(client: pg.PoolClient, source: string, stream: SyncStream): Promise<CursorRow> {
  const { rows } = await client.query<RawCursor>(
    'SELECT * FROM sync_cursors WHERE source_system = $1 AND stream = $2 FOR UPDATE',
    [source, stream],
  );
  return toCursor(rows[0]!);
}

/** Moves the cursor. Only a completely drained feed counts as a verified, successful sync. */
export async function advanceCursor(
  client: pg.PoolClient,
  source: string,
  stream: SyncStream,
  page: { next_seq: number; head_seq: number; feed_epoch: string; has_more: boolean },
): Promise<void> {
  await client.query(
    `UPDATE sync_cursors
        SET last_seq = $3, source_head_seq = $4, feed_epoch = $5, last_attempt_at = now(),
            continuity_ok = CASE WHEN $6 THEN continuity_ok ELSE TRUE END,
            last_successful_sync_at = CASE WHEN $6 THEN last_successful_sync_at ELSE now() END,
            last_error = CASE WHEN $6 THEN last_error ELSE NULL END,
            consecutive_failures = CASE WHEN $6 THEN consecutive_failures ELSE 0 END
      WHERE source_system = $1 AND stream = $2`,
    [source, stream, page.next_seq, page.head_seq, page.feed_epoch, page.has_more],
  );
}

export async function recordSyncFailure(db: Queryable, source: string, stream: SyncStream, error: string) {
  await db.query(
    `UPDATE sync_cursors
        SET last_attempt_at = now(), last_error = $3, consecutive_failures = consecutive_failures + 1
      WHERE source_system = $1 AND stream = $2`,
    [source, stream, error],
  );
}

/** The cursor can no longer be trusted, so nothing built on it may back a commitment until a new snapshot. */
export async function breakContinuity(db: Queryable, source: string, stream: SyncStream, error: string) {
  await db.query(
    `UPDATE sync_cursors
        SET continuity_ok = FALSE, last_seq = 0, last_attempt_at = now(), last_error = $3,
            consecutive_failures = consecutive_failures + 1
      WHERE source_system = $1 AND stream = $2`,
    [source, stream, error],
  );
}

export async function clearInventoryView(client: pg.PoolClient): Promise<void> {
  await client.query('DELETE FROM inventory_view');
}

/**
 * Upserts a source row. ingested_at moves only when a new source version arrives, so unchanged stock
 * keeps its real timestamps. When ignoreVersion is false, an older version never overwrites a newer one.
 */
export async function upsertInventoryRow(
  client: pg.PoolClient,
  row: SourceInventory,
  normalization: { normalizedUnit: string | null; pending: boolean },
  ignoreVersion: boolean,
): Promise<void> {
  await client.query(
    `INSERT INTO inventory_view (node_id, sku_id, on_hand, reserved, source_updated_at, source_version,
                                 source_unit, normalized_unit, normalization_pending)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (node_id, sku_id) DO UPDATE SET
       on_hand = EXCLUDED.on_hand,
       reserved = EXCLUDED.reserved,
       ingested_at = CASE WHEN inventory_view.source_version <> EXCLUDED.source_version THEN now()
                          ELSE inventory_view.ingested_at END,
       source_updated_at = EXCLUDED.source_updated_at,
       source_version = EXCLUDED.source_version,
       source_unit = EXCLUDED.source_unit,
       normalized_unit = EXCLUDED.normalized_unit,
       normalization_pending = EXCLUDED.normalization_pending
     WHERE $10 OR EXCLUDED.source_version >= inventory_view.source_version`,
    [
      row.node_id,
      row.sku_id,
      row.on_hand,
      row.reserved,
      row.updated_at,
      row.version,
      row.source_unit,
      normalization.normalizedUnit,
      normalization.pending,
      ignoreVersion,
    ],
  );
}

/** Applies the stock row the source returned from a reservation call, ahead of the next sync. */
export async function applySourceStock(db: Queryable, row: SourceInventory): Promise<void> {
  await db.query(
    `UPDATE inventory_view
        SET on_hand = $3, reserved = $4, source_updated_at = $5, source_version = $6, ingested_at = now()
      WHERE node_id = $1 AND sku_id = $2 AND source_version < $6`,
    [row.node_id, row.sku_id, row.on_hand, row.reserved, row.updated_at, row.version],
  );
}

export interface StockRow {
  node_id: string;
  sku_id: string;
  on_hand: number;
  reserved: number;
  normalization_pending: boolean;
  normalized_unit: string | null;
  base_unit: string | null;
  product_status: string;
  source_updated_at: Date;
  ingested_at: Date;
}

export async function listStock(db: Queryable, skuIds?: string[]): Promise<StockRow[]> {
  const { rows } = await db.query<StockRow>(
    `SELECT v.node_id, v.sku_id, v.on_hand, v.reserved, v.normalization_pending, v.normalized_unit,
            v.source_updated_at, v.ingested_at, p.base_unit, p.status AS product_status
       FROM inventory_view v JOIN products p USING (sku_id)
      WHERE $1::text[] IS NULL OR v.sku_id = ANY($1)
      ORDER BY v.node_id, v.sku_id`,
    [skuIds ?? null],
  );
  return rows;
}

export async function getConnectorEnabled(db: Queryable, source: string): Promise<boolean> {
  const { rows } = await db.query<{ enabled: boolean }>('SELECT enabled FROM connector_settings WHERE source_system = $1', [
    source,
  ]);
  return rows[0]?.enabled ?? true;
}

export async function setConnectorEnabled(db: Queryable, source: string, enabled: boolean, actor: string) {
  await db.query(
    `INSERT INTO connector_settings (source_system, enabled, updated_by) VALUES ($1, $2, $3)
     ON CONFLICT (source_system) DO UPDATE
       SET enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [source, enabled, actor],
  );
}
