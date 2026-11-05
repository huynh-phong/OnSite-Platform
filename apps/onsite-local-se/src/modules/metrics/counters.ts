import type { Db } from '../../db.js';

interface Queryable {
  query: Db['query'];
}

export const COUNTERS = {
  aiCalls: 'ai_calls_total',
  cacheHits: 'normalization_cache_hits_total',
  records: 'normalization_records_total',
  acceptedAsIs: 'ai_outcome_accepted_as_is',
  edited: 'ai_outcome_edited',
  rejected: 'ai_outcome_rejected',
  invalidOutput: 'ai_outcome_invalid_output',
  aiUnavailable: 'ai_outcome_unavailable',
  reservationConflicts: 'reservation_conflicts',
  renewals: 'reservation_renewals_total',
  renewalFailures: 'reservation_renewal_failures_total',
  reservationsLost: 'reservations_lost_total',
  atRiskAlerts: 'at_risk_alerts_sent',
  syncFailures: 'sync_failures_total',
  orderReads: 'order_reader_calls_total',
  orderReadFailures: 'order_reader_failures_total',
} as const;

export async function bumpCounter(db: Queryable, name: string, by = 1): Promise<void> {
  if (by === 0) return;
  await db.query(
    `INSERT INTO metric_counters (name, value) VALUES ($1, $2)
     ON CONFLICT (name) DO UPDATE SET value = metric_counters.value + EXCLUDED.value`,
    [name, by],
  );
}

export async function readCounters(db: Queryable): Promise<Record<string, number>> {
  const { rows } = await db.query<{ name: string; value: string }>('SELECT name, value FROM metric_counters');
  return Object.fromEntries(rows.map((row) => [row.name, Number(row.value)]));
}
