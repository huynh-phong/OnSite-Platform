import type pg from 'pg';
import type { Db } from '../db.js';
import { SimError } from '../errors.js';

const FEED_LOCK_ID = 727101;
const DEFAULT_PAGE = 500;

export type FeedEntity = 'product' | 'inventory';

/**
 * Must be the last statement of a transaction. The lock makes seq order match commit order, so a
 * consumer that has read up to seq N can never later miss an uncommitted row with a lower seq.
 */
export async function appendFeed(client: pg.PoolClient, entity: FeedEntity, entityId: string): Promise<number> {
  await client.query('SELECT pg_advisory_xact_lock($1)', [FEED_LOCK_ID]);
  const { rows } = await client.query<{ seq: string }>(
    'INSERT INTO change_feed (entity, entity_id) VALUES ($1, $2) RETURNING seq',
    [entity, entityId],
  );
  return Number(rows[0]!.seq);
}

export interface FeedPage<T> {
  items: T[];
  next_seq: number;
  head_seq: number;
  feed_epoch: string;
  has_more: boolean;
  snapshot: boolean;
}

interface FeedQueries<T> {
  entity: FeedEntity;
  /** Every row, used for the since_seq=0 snapshot. */
  all: string;
  /** Rows by entity id, $1 is a text[] of ids, in any order. */
  byIds: string;
  id: (row: T) => string;
}

async function settings(pool: Db) {
  const { rows } = await pool.query<{ feed_epoch: string; feed_trimmed_through: string }>(
    'SELECT feed_epoch, feed_trimmed_through FROM sim_settings',
  );
  const row = rows[0];
  if (!row) throw new SimError(503, 'NOT_SEEDED', 'The simulator has not been seeded');
  return { epoch: row.feed_epoch, trimmedThrough: Number(row.feed_trimmed_through) };
}

/**
 * since_seq=0 returns a full snapshot of current state. A positive cursor returns the current state of
 * rows changed after it. A cursor that can no longer be honoured is refused instead of silently skipping.
 */
export async function readFeed<T extends pg.QueryResultRow>(
  pool: Db,
  queries: FeedQueries<T>,
  sinceSeq: number,
  limit = DEFAULT_PAGE,
): Promise<FeedPage<T>> {
  const { epoch, trimmedThrough } = await settings(pool);
  // Read before the rows: rows may be newer than head, which only causes a harmless re-read.
  const head = await pool.query<{ head: string }>('SELECT COALESCE(max(seq), 0) AS head FROM change_feed');
  const headSeq = Math.max(Number(head.rows[0]!.head), trimmedThrough);

  if (sinceSeq === 0) {
    const { rows } = await pool.query<T>(queries.all);
    return { items: rows, next_seq: headSeq, head_seq: headSeq, feed_epoch: epoch, has_more: false, snapshot: true };
  }
  if (sinceSeq < trimmedThrough) {
    throw new SimError(410, 'CURSOR_EXPIRED', 'Changes after this cursor are no longer available; take a snapshot', {
      feed_epoch: epoch,
      trimmed_through: trimmedThrough,
    });
  }
  if (sinceSeq > headSeq) {
    throw new SimError(409, 'CURSOR_AHEAD', 'This cursor is ahead of the feed; take a snapshot', {
      feed_epoch: epoch,
      head_seq: headSeq,
    });
  }

  const changed = await pool.query<{ entity_id: string; last_seq: string }>(
    `SELECT entity_id, max(seq) AS last_seq FROM change_feed
      WHERE entity = $1 AND seq > $2
      GROUP BY entity_id ORDER BY max(seq) LIMIT $3`,
    [queries.entity, sinceSeq, limit],
  );
  const ids = changed.rows.map((row) => row.entity_id);
  const rows = ids.length ? (await pool.query<T>(queries.byIds, [ids])).rows : [];
  const order = new Map(ids.map((id, index) => [id, index]));
  rows.sort((a, b) => (order.get(queries.id(a)) ?? 0) - (order.get(queries.id(b)) ?? 0));

  const hasMore = changed.rows.length === limit;
  const pageMax = Number(changed.rows.at(-1)?.last_seq ?? 0);
  return {
    items: rows,
    next_seq: hasMore ? pageMax : Math.max(headSeq, pageMax),
    head_seq: headSeq,
    feed_epoch: epoch,
    has_more: hasMore,
    snapshot: false,
  };
}

/** Controlled failure: removes old feed rows so that older cursors become invalid. */
export async function trimFeed(pool: Db, throughSeq: number): Promise<number> {
  await pool.query('DELETE FROM change_feed WHERE seq <= $1', [throughSeq]);
  await pool.query('UPDATE sim_settings SET feed_trimmed_through = GREATEST(feed_trimmed_through, $1)', [throughSeq]);
  return throughSeq;
}
