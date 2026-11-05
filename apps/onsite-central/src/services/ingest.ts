import type { Db } from '../db.js';
import { withTransaction } from '../db.js';

export interface IncomingEvent {
  event_id: string;
  event_type: string;
  origin_country: string;
  aggregate_type: string;
  aggregate_id: string;
  aggregate_version: number;
  occurred_at: string;
  payload: Record<string, unknown>;
}

/**
 * The only payload fields Central ever stores. Anything else is dropped, whatever Local sends, so that a
 * mistake upstream cannot put a name, address, contact or free-text note into this database.
 */
const ALLOWED_PAYLOAD: Record<string, 'string' | 'number' | 'boolean'> = {
  status: 'string',
  sales_store_id: 'string',
  shipment_count: 'number',
  line_count: 'number',
  at_risk: 'boolean',
  early_shortage_detected: 'boolean',
  otif: 'boolean',
  eta: 'string',
  requested_delivery_at: 'string',
  created_at: 'string',
  node_id: 'string',
  task_status: 'string',
  reason: 'string',
  on_time: 'boolean',
  in_full: 'boolean',
};

const CODE = /^[A-Za-z0-9_.:+-]{1,64}$/;

export function filterPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const filtered: Record<string, unknown> = {};
  for (const [key, type] of Object.entries(ALLOWED_PAYLOAD)) {
    const value = payload[key];
    // Strings here are codes and timestamps. Longer or spaced text is not one of them.
    if (typeof value === type && (type !== 'string' || CODE.test(value as string))) filtered[key] = value;
  }
  return filtered;
}

export type IngestResult = 'applied' | 'duplicate' | 'out_of_order';

/**
 * One transaction per event. The inbox insert decides duplicates, even between concurrent deliveries, and
 * the projection only moves to a higher version, so a late event is recorded but cannot undo a newer state.
 */
export async function ingestEvent(pool: Db, event: IncomingEvent): Promise<IngestResult> {
  const payload = filterPayload(event.payload);
  return withTransaction(pool, async (client) => {
    await client.query(`INSERT INTO country_status (origin_country) VALUES ($1) ON CONFLICT DO NOTHING`, [
      event.origin_country,
    ]);
    const inserted = await client.query(
      `INSERT INTO inbox_events (origin_country, event_id, event_type, aggregate_type, aggregate_id, aggregate_version,
                                 occurred_at, payload, projected, sync_lag_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, FALSE,
               GREATEST(0, (EXTRACT(EPOCH FROM clock_timestamp() - $7::timestamptz) * 1000)::bigint))
       ON CONFLICT (origin_country, event_id) DO NOTHING`,
      [
        event.origin_country,
        event.event_id,
        event.event_type,
        event.aggregate_type,
        event.aggregate_id,
        event.aggregate_version,
        event.occurred_at,
        JSON.stringify(payload),
      ],
    );
    if (!inserted.rowCount) {
      await client.query(
        `UPDATE country_status SET duplicate_events_ignored = duplicate_events_ignored + 1, last_received_at = now()
          WHERE origin_country = $1`,
        [event.origin_country],
      );
      return 'duplicate';
    }

    let projected = false;
    if (event.aggregate_type === 'order' && typeof payload.status === 'string') {
      const moved = await client.query(
        `INSERT INTO order_projection (origin_country, order_id, version, status, sales_store_id, shipment_count, line_count,
                                       at_risk, early_shortage_detected, otif, eta, requested_delivery_at, order_created_at,
                                       last_event_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (origin_country, order_id) DO UPDATE SET
           version = EXCLUDED.version, status = EXCLUDED.status, sales_store_id = EXCLUDED.sales_store_id,
           shipment_count = EXCLUDED.shipment_count, line_count = EXCLUDED.line_count, at_risk = EXCLUDED.at_risk,
           early_shortage_detected = EXCLUDED.early_shortage_detected, otif = EXCLUDED.otif, eta = EXCLUDED.eta,
           requested_delivery_at = EXCLUDED.requested_delivery_at, order_created_at = EXCLUDED.order_created_at,
           last_event_at = EXCLUDED.last_event_at, updated_at = now()
         WHERE EXCLUDED.version > order_projection.version`,
        [
          event.origin_country,
          event.aggregate_id,
          event.aggregate_version,
          payload.status,
          payload.sales_store_id ?? null,
          payload.shipment_count ?? null,
          payload.line_count ?? null,
          payload.at_risk ?? false,
          payload.early_shortage_detected ?? false,
          payload.otif ?? null,
          payload.eta ?? null,
          payload.requested_delivery_at ?? null,
          payload.created_at ?? null,
          event.occurred_at,
        ],
      );
      projected = Boolean(moved.rowCount);
    }
    await client.query(`UPDATE inbox_events SET projected = $3 WHERE origin_country = $1 AND event_id = $2`, [
      event.origin_country,
      event.event_id,
      projected,
    ]);
    await client.query(
      `UPDATE country_status
          SET events_received = events_received + 1, last_received_at = now(),
              last_event_occurred_at = GREATEST(last_event_occurred_at, $2::timestamptz),
              out_of_order_events = out_of_order_events + $3
        WHERE origin_country = $1`,
      [event.origin_country, event.occurred_at, projected ? 0 : 1],
    );
    return projected ? 'applied' : 'out_of_order';
  });
}

export async function isIngestionOffline(pool: Db): Promise<boolean> {
  const { rows } = await pool.query<{ ingestion_offline: boolean }>('SELECT ingestion_offline FROM central_settings');
  return rows[0]?.ingestion_offline ?? false;
}

export async function noteRefusal(pool: Db): Promise<void> {
  await pool.query('UPDATE central_settings SET refused_while_down = refused_while_down + 1');
}

export async function setIngestionOffline(pool: Db, offline: boolean): Promise<boolean> {
  await pool.query('UPDATE central_settings SET ingestion_offline = $1', [offline]);
  return offline;
}

export async function resetCentral(pool: Db): Promise<void> {
  await withTransaction(pool, async (client) => {
    await client.query('TRUNCATE inbox_events, order_projection, country_status');
    await client.query('UPDATE central_settings SET ingestion_offline = FALSE, refused_while_down = 0');
  });
}
