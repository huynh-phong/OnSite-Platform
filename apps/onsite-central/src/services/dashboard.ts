import type { Db } from '../db.js';

/** Sweden is the only deployment. The others are named so that nobody mistakes them for live ones. */
const PLANNED_COUNTRIES = ['DK', 'NO'];
const ACTIVE_WITHIN_SECONDS = 300;

export type CountryState = 'ACTIVE' | 'IDLE' | 'NO_EVENTS_YET' | 'INGESTION_OFFLINE' | 'FUTURE_EXPANSION';

export function countryState(
  lastReceivedAt: Date | null,
  ingestionOffline: boolean,
  now = new Date(),
): CountryState {
  if (ingestionOffline) return 'INGESTION_OFFLINE';
  if (!lastReceivedAt) return 'NO_EVENTS_YET';
  // No events only means no order activity here: Central cannot tell a quiet Local from a stopped one.
  return (now.getTime() - lastReceivedAt.getTime()) / 1000 <= ACTIVE_WITHIN_SECONDS ? 'ACTIVE' : 'IDLE';
}

interface CountryRow {
  origin_country: string;
  last_event_occurred_at: Date | null;
  last_received_at: Date | null;
  events_received: string;
  duplicate_events_ignored: string;
  out_of_order_events: string;
}

export async function countriesStatus(pool: Db) {
  const [{ rows }, settings] = await Promise.all([
    pool.query<CountryRow>('SELECT * FROM country_status ORDER BY origin_country'),
    pool.query<{ ingestion_offline: boolean }>('SELECT ingestion_offline FROM central_settings'),
  ]);
  const offline = settings.rows[0]?.ingestion_offline ?? false;
  const known = new Map(rows.map((row) => [row.origin_country, row]));
  const live = known.get('SE');
  return [
    ...(live ? [] : [{ origin_country: 'SE', row: undefined }]),
    ...rows.map((row) => ({ origin_country: row.origin_country, row })),
  ]
    .map(({ origin_country, row }) => ({
      origin_country,
      deployed: true,
      state: countryState(row?.last_received_at ?? null, offline),
      last_event_occurred_at: row?.last_event_occurred_at?.toISOString() ?? null,
      last_received_at: row?.last_received_at?.toISOString() ?? null,
      events_received: Number(row?.events_received ?? 0),
      duplicate_events_ignored: Number(row?.duplicate_events_ignored ?? 0),
      out_of_order_events: Number(row?.out_of_order_events ?? 0),
    }))
    .concat(
      PLANNED_COUNTRIES.filter((country) => !known.has(country)).map((origin_country) => ({
        origin_country,
        deployed: false,
        state: 'FUTURE_EXPANSION' as const,
        last_event_occurred_at: null,
        last_received_at: null,
        events_received: 0,
        duplicate_events_ignored: 0,
        out_of_order_events: 0,
      })),
    );
}

export async function dashboard(pool: Db) {
  const [byStatus, kpi, lag, settings, countries] = await Promise.all([
    pool.query<{ status: string; count: number }>(
      'SELECT status, count(*)::int AS count FROM order_projection GROUP BY status ORDER BY status',
    ),
    pool.query<{
      total: number;
      at_risk: number;
      early_shortage: number;
      delivered: number;
      otif_true: number;
    }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE at_risk AND status IN ('AWAITING_APPROVAL', 'APPROVED', 'DISPATCHING', 'DISPATCHED'))::int AS at_risk,
              count(*) FILTER (WHERE early_shortage_detected)::int AS early_shortage,
              count(*) FILTER (WHERE status = 'DELIVERED')::int AS delivered,
              count(*) FILTER (WHERE status = 'DELIVERED' AND otif)::int AS otif_true
         FROM order_projection`,
    ),
    pool.query<{ p50: number | null; p95: number | null; latest: string | null; sampled: number }>(
      `WITH recent AS (SELECT sync_lag_ms, applied_at FROM inbox_events ORDER BY applied_at DESC LIMIT 200)
       SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY sync_lag_ms)::float8 AS p50,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY sync_lag_ms)::float8 AS p95,
              (SELECT sync_lag_ms FROM recent ORDER BY applied_at DESC LIMIT 1) AS latest,
              count(*)::int AS sampled
         FROM recent`,
    ),
    pool.query<{ ingestion_offline: boolean; refused_while_down: string }>('SELECT * FROM central_settings'),
    countriesStatus(pool),
  ]);
  const totals = kpi.rows[0]!;
  const row = lag.rows[0]!;
  return {
    data_is_simulated: true,
    ingestion_offline: settings.rows[0]?.ingestion_offline ?? false,
    refused_while_offline: Number(settings.rows[0]?.refused_while_down ?? 0),
    countries,
    orders_by_status: byStatus.rows,
    kpis: {
      total_orders: totals.total,
      at_risk_orders: totals.at_risk,
      early_shortage_detected: totals.early_shortage,
      delivered_orders: totals.delivered,
      simulated_otif_rate: totals.delivered === 0 ? null : totals.otif_true / totals.delivered,
    },
    central_sync_lag_ms: {
      latest: row.latest === null ? null : Number(row.latest),
      p50: row.p50,
      p95: row.p95,
      sampled_events: row.sampled,
    },
  };
}

export async function recentEvents(pool: Db, limit: number) {
  const { rows } = await pool.query(
    `SELECT event_id, event_type, origin_country, aggregate_id, aggregate_version, occurred_at, applied_at, projected, sync_lag_ms::float8 AS sync_lag_ms
       FROM inbox_events ORDER BY applied_at DESC, aggregate_version DESC LIMIT $1`,
    [limit],
  );
  return rows.map((row) => ({
    ...row,
    occurred_at: row.occurred_at.toISOString(),
    applied_at: row.applied_at.toISOString(),
  }));
}
