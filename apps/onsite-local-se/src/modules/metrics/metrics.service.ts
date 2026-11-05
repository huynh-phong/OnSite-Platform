import type { Config } from '../../config.js';
import type { Db } from '../../db.js';
import type { InventoryService } from '../inventory/inventory.service.js';
import { COUNTERS, readCounters } from './counters.js';

const SAMPLE_LIMIT = 2000;

/** Keeps recent API latencies in memory, for p50 and p95. */
export class LatencyTracker {
  private readonly samples: number[] = [];

  record(milliseconds: number): void {
    this.samples.push(milliseconds);
    if (this.samples.length > SAMPLE_LIMIT) this.samples.shift();
  }

  percentile(p: number): number | null {
    if (this.samples.length === 0) return null;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
    return Math.round(sorted[index]! * 10) / 10;
  }

  get count(): number {
    return this.samples.length;
  }
}

export class MetricsService {
  constructor(
    private readonly pool: Db,
    private readonly config: Config,
    private readonly inventory: InventoryService,
    private readonly latency: LatencyTracker,
  ) {}

  async snapshot() {
    const [counters, outbox, orders, reviewAge, confirmation, nodeAges, freshness] = await Promise.all([
      readCounters(this.pool),
      this.pool.query<{ pending: string; delivered: string; dead: string; oldest_age_s: number | null }>(
        `SELECT count(*) FILTER (WHERE status = 'PENDING') AS pending,
                count(*) FILTER (WHERE status = 'DELIVERED') AS delivered,
                count(*) FILTER (WHERE status = 'DEAD') AS dead,
                EXTRACT(EPOCH FROM now() - min(occurred_at) FILTER (WHERE status = 'PENDING'))::float8 AS oldest_age_s
           FROM outbox_events`,
      ),
      this.pool.query<{
        early_shortage: string;
        at_risk: string;
        delivered: string;
        otif_true: string;
        total: string;
      }>(
        `SELECT count(*) FILTER (WHERE early_shortage_detected) AS early_shortage,
                count(*) FILTER (WHERE at_risk AND status IN ('AWAITING_APPROVAL', 'APPROVED', 'DISPATCHING', 'DISPATCHED')) AS at_risk,
                count(*) FILTER (WHERE status = 'DELIVERED') AS delivered,
                count(*) FILTER (WHERE status = 'DELIVERED' AND otif) AS otif_true,
                count(*) AS total
           FROM orders`,
      ),
      this.pool.query<{ pending: string; oldest_age_s: number | null }>(
        `SELECT count(*) AS pending, EXTRACT(EPOCH FROM now() - min(created_at))::float8 AS oldest_age_s
           FROM normalization_review_queue WHERE status = 'PENDING'`,
      ),
      this.pool.query<{ avg_s: number | null }>(
        `SELECT avg(EXTRACT(EPOCH FROM approved_at - created_at))::float8 AS avg_s FROM orders WHERE approved_at IS NOT NULL`,
      ),
      this.pool.query<{ node_id: string; rows: string; newest_source_age_s: number; newest_ingest_age_s: number }>(
        `SELECT node_id, count(*) AS rows,
                EXTRACT(EPOCH FROM now() - max(source_updated_at))::float8 AS newest_source_age_s,
                EXTRACT(EPOCH FROM now() - max(ingested_at))::float8 AS newest_ingest_age_s
           FROM inventory_view GROUP BY node_id ORDER BY node_id`,
      ),
      this.inventory.freshness(),
    ]);

    const value = (name: string) => counters[name] ?? 0;
    const hits = value(COUNTERS.cacheHits);
    const records = value(COUNTERS.records);
    const delivered = Number(orders.rows[0]!.delivered);
    return {
      api: {
        p50_ms: this.latency.percentile(50),
        p95_ms: this.latency.percentile(95),
        samples: this.latency.count,
      },
      inventory: {
        trusted: freshness.trusted,
        stale_reason: freshness.staleReason,
        last_successful_sync_at: freshness.lastSuccessfulSyncAt?.toISOString() ?? null,
        verified_age_s: freshness.verifiedAgeSeconds,
        stale_after_s: this.config.inventory.staleAfterSeconds,
        sync_failures_total: value(COUNTERS.syncFailures),
        // inventory_freshness_s per node is the time since the feed was verified; the per-node ages show
        // how long ago stock last changed there, which is normal for a quiet node.
        nodes: nodeAges.rows.map((row) => ({
          node_id: row.node_id,
          rows: Number(row.rows),
          inventory_freshness_s: freshness.verifiedAgeSeconds,
          newest_source_change_age_s: row.newest_source_age_s,
          newest_ingest_age_s: row.newest_ingest_age_s,
        })),
      },
      outbox: {
        outbox_pending: Number(outbox.rows[0]!.pending),
        outbox_delivered: Number(outbox.rows[0]!.delivered),
        outbox_dead: Number(outbox.rows[0]!.dead),
        outbox_oldest_age_s: outbox.rows[0]!.oldest_age_s,
      },
      reservations: {
        reservation_conflicts: value(COUNTERS.reservationConflicts),
        renewals_total: value(COUNTERS.renewals),
        renewal_failures_total: value(COUNTERS.renewalFailures),
        lost_total: value(COUNTERS.reservationsLost),
      },
      ai: {
        ai_calls_total: value(COUNTERS.aiCalls),
        normalization_cache_hits_total: hits,
        normalization_records_total: records,
        normalization_cache_hit_rate: records === 0 ? null : hits / records,
        outcomes: {
          accepted_as_is: value(COUNTERS.acceptedAsIs),
          edited: value(COUNTERS.edited),
          rejected: value(COUNTERS.rejected),
          invalid_output: value(COUNTERS.invalidOutput),
          unavailable: value(COUNTERS.aiUnavailable),
        },
        review_queue_pending: Number(reviewAge.rows[0]!.pending),
        review_queue_oldest_age_s: reviewAge.rows[0]!.oldest_age_s,
      },
      business: {
        simulated_data: true,
        orders_total: Number(orders.rows[0]!.total),
        early_shortage_detected: Number(orders.rows[0]!.early_shortage),
        at_risk_count: Number(orders.rows[0]!.at_risk),
        at_risk_alerts_sent: value(COUNTERS.atRiskAlerts),
        delivered_orders: delivered,
        otif_rate: delivered === 0 ? null : Number(orders.rows[0]!.otif_true) / delivered,
        order_confirmation_time_s: confirmation.rows[0]!.avg_s,
      },
    };
  }
}
