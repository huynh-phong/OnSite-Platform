import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../../config.js';
import type { Db } from '../../db.js';

interface OutboxRow {
  outbox_id: string;
  event_id: string;
  origin_country: string;
  aggregate_type: string;
  aggregate_id: string;
  aggregate_version: number;
  event_type: string;
  payload: unknown;
  occurred_at: Date;
  retry_count: number;
  non_retryable_failures: number;
}

/** Exponential backoff with full jitter. */
export function backoffMs(retry: number, baseMs: number, maxMs: number, random = Math.random()): number {
  return Math.floor(random * Math.min(maxMs, baseMs * 2 ** retry));
}

export class OutboxSender {
  constructor(
    private readonly pool: Db,
    private readonly config: Config,
    private readonly log: FastifyBaseLogger,
  ) {}

  /**
   * Sends due events, at least once. Events are claimed with SKIP LOCKED and a short lease rather than a
   * transaction held across the network. Without CENTRAL_INGEST_URL it does nothing: events stay PENDING
   * and Local SE keeps working.
   */
  async tick(): Promise<number> {
    const url = this.config.centralIngestUrl;
    if (!url) return 0;
    const { batchSize, leaseSeconds } = this.config.outbox;
    const { rows } = await this.pool.query<OutboxRow>(
      `UPDATE outbox_events SET next_attempt_at = now() + make_interval(secs => $2)
        WHERE outbox_id IN (
          SELECT outbox_id FROM outbox_events
           WHERE status = 'PENDING' AND next_attempt_at <= now()
           ORDER BY outbox_id LIMIT $1 FOR UPDATE SKIP LOCKED)
        RETURNING *`,
      [batchSize, leaseSeconds],
    );
    let delivered = 0;
    for (const event of rows.sort((a, b) => Number(a.outbox_id) - Number(b.outbox_id))) {
      if (await this.send(url, event)) delivered += 1;
    }
    return delivered;
  }

  private async send(url: string, event: OutboxRow): Promise<boolean> {
    let status: number | undefined;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.config.centralServiceToken ? { authorization: `Bearer ${this.config.centralServiceToken}` } : {}),
        },
        body: JSON.stringify({
          event_id: event.event_id,
          event_type: event.event_type,
          origin_country: event.origin_country,
          aggregate_type: event.aggregate_type,
          aggregate_id: event.aggregate_id,
          aggregate_version: event.aggregate_version,
          occurred_at: event.occurred_at.toISOString(),
          payload: event.payload,
        }),
        signal: AbortSignal.timeout(this.config.outbox.timeoutMs),
      });
      status = response.status;
    } catch {
      status = undefined;
    }

    if (status !== undefined && status >= 200 && status < 300) {
      await this.pool.query(`UPDATE outbox_events SET status = 'DELIVERED', delivered_at = now() WHERE outbox_id = $1`, [
        event.outbox_id,
      ]);
      return true;
    }

    const refused = status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429;
    const failures = event.non_retryable_failures + (refused ? 1 : 0);
    const dead = failures >= this.config.outbox.maxNonRetryableFailures;
    if (dead) this.log.error({ event_id: event.event_id, status }, 'outbox event is dead');
    const { baseBackoffMs, maxBackoffMs } = this.config.outbox;
    await this.pool.query(
      `UPDATE outbox_events
          SET retry_count = retry_count + 1, non_retryable_failures = $2, status = $3,
              next_attempt_at = now() + make_interval(secs => $4)
        WHERE outbox_id = $1`,
      [
        event.outbox_id,
        failures,
        dead ? 'DEAD' : 'PENDING',
        backoffMs(event.retry_count, baseBackoffMs, maxBackoffMs) / 1000,
      ],
    );
    return false;
  }
}
