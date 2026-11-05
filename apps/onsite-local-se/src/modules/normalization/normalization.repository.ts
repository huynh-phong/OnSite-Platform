import type pg from 'pg';
import type { Db } from '../../db.js';
import type { NormalizationField } from './key.js';

type Queryable = Pick<Db, 'query'>;

export interface ReviewRow {
  review_id: string;
  source_system: string;
  field: NormalizationField;
  raw_value_hash: string;
  raw_value: string;
  source_description: string | null;
  ai_suggestion: string | null;
  confidence: string | null;
  ai_reason: string | null;
  ai_evidence: string | null;
  model_version: string | null;
  pending_record_count: number;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  outcome: string | null;
  final_value: string | null;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  created_at: Date;
  ai_status: 'QUEUED' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
  ai_claim_token: string | null;
  ai_attempts: number;
  reject_reason: string | null;
}

export interface WaitingRecord {
  record_id: string;
  entity_type: 'product' | 'inventory';
  entity_id: string;
  raw_payload: unknown;
}

export async function findApprovedMapping(client: Queryable, source: string, field: string, hash: string) {
  const { rows } = await client.query<{ normalized_value: string }>(
    `SELECT normalized_value FROM normalization_mappings
      WHERE source_system = $1 AND field = $2 AND raw_value_hash = $3 AND status = 'APPROVED'`,
    [source, field, hash],
  );
  return rows[0]?.normalized_value;
}

export async function addMappingHits(client: pg.PoolClient, source: string, field: string, hash: string, hits: number) {
  await client.query(
    `UPDATE normalization_mappings SET hit_count = hit_count + $4
      WHERE source_system = $1 AND field = $2 AND raw_value_hash = $3`,
    [source, field, hash, hits],
  );
}

/**
 * The atomic claim on a value. Exactly one concurrent caller inserts the row; only an inserted row
 * ever reaches the AI queue, so a value gets one AI call however many records arrive at once.
 */
export async function findOrCreatePendingReview(
  client: pg.PoolClient,
  input: { source: string; field: string; hash: string; raw: string; description: string | null },
): Promise<ReviewRow> {
  const inserted = await client.query<ReviewRow>(
    `INSERT INTO normalization_review_queue
       (source_system, field, raw_value_hash, raw_value, source_description, ai_status)
     VALUES ($1, $2, $3, $4, $5, 'QUEUED')
     ON CONFLICT (source_system, field, raw_value_hash) WHERE status = 'PENDING' DO NOTHING
     RETURNING *`,
    [input.source, input.field, input.hash, input.raw, input.description],
  );
  if (inserted.rows[0]) return inserted.rows[0];
  const { rows } = await client.query<ReviewRow>(
    `SELECT * FROM normalization_review_queue
      WHERE source_system = $1 AND field = $2 AND raw_value_hash = $3 AND status = 'PENDING'`,
    [input.source, input.field, input.hash],
  );
  return rows[0]!;
}

export async function findRejectedReview(client: Queryable, source: string, field: string, hash: string) {
  const { rows } = await client.query<ReviewRow>(
    `SELECT * FROM normalization_review_queue
      WHERE source_system = $1 AND field = $2 AND raw_value_hash = $3 AND status = 'REJECTED'
      ORDER BY created_at DESC LIMIT 1`,
    [source, field, hash],
  );
  return rows[0];
}

/** A record sent again while waiting replaces its payload and is not counted twice. */
export async function attachRecord(
  client: pg.PoolClient,
  input: {
    reviewId: string;
    entityType: 'product' | 'inventory';
    entityId: string;
    payload: unknown;
    status: 'WAITING' | 'MANUAL';
  },
): Promise<void> {
  const { rows } = await client.query<{ inserted: boolean }>(
    `INSERT INTO pending_normalized_records (review_id, entity_type, entity_id, raw_payload, status)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (review_id, entity_type, entity_id) WHERE status IN ('WAITING', 'MANUAL')
       DO UPDATE SET raw_payload = EXCLUDED.raw_payload
     RETURNING (xmax = 0) AS inserted`,
    [input.reviewId, input.entityType, input.entityId, JSON.stringify(input.payload), input.status],
  );
  if (rows[0]?.inserted && input.status === 'WAITING') {
    await client.query(
      `UPDATE normalization_review_queue SET pending_record_count = pending_record_count + 1 WHERE review_id = $1`,
      [input.reviewId],
    );
  }
}

/** Claims queued reviews, and reviews whose earlier call was interrupted and whose lease has run out. */
export async function claimAiWork(
  db: Queryable,
  input: { token: string; leaseSeconds: number; limit: number },
): Promise<ReviewRow[]> {
  const { rows } = await db.query<ReviewRow>(
    `UPDATE normalization_review_queue
        SET ai_status = 'IN_PROGRESS', ai_claim_token = $1, ai_claimed_at = now(), ai_attempts = ai_attempts + 1
      WHERE review_id IN (
        SELECT review_id FROM normalization_review_queue
         WHERE status = 'PENDING'
           AND (ai_status = 'QUEUED'
                OR (ai_status = 'IN_PROGRESS' AND ai_claimed_at < now() - make_interval(secs => $2)))
         ORDER BY created_at
         LIMIT $3
         FOR UPDATE SKIP LOCKED)
      RETURNING *`,
    [input.token, input.leaseSeconds, input.limit],
  );
  return rows;
}

/** Writes the result only if this worker still holds the claim, so a late call cannot overwrite a retry. */
export async function completeAiWork(
  db: Queryable,
  reviewId: string,
  token: string,
  result: {
    aiStatus: 'COMPLETED' | 'FAILED';
    suggestion: string | null;
    confidence: number | null;
    reason: string;
    evidence: string | null;
    modelVersion: string;
  },
): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE normalization_review_queue
        SET ai_status = $3, ai_suggestion = $4, confidence = $5, ai_reason = $6, ai_evidence = $7, model_version = $8
      WHERE review_id = $1 AND ai_claim_token = $2 AND ai_status = 'IN_PROGRESS' AND status = 'PENDING'`,
    [
      reviewId,
      token,
      result.aiStatus,
      result.suggestion,
      result.confidence,
      result.reason,
      result.evidence,
      result.modelVersion,
    ],
  );
  return (rowCount ?? 0) > 0;
}

export async function listReviews(db: Queryable, status?: string): Promise<ReviewRow[]> {
  const { rows } = await db.query<ReviewRow>(
    `SELECT * FROM normalization_review_queue WHERE $1::text IS NULL OR status = $1 ORDER BY created_at`,
    [status ?? null],
  );
  return rows;
}

export async function lockReview(client: pg.PoolClient, reviewId: string): Promise<ReviewRow | undefined> {
  const { rows } = await client.query<ReviewRow>(
    'SELECT * FROM normalization_review_queue WHERE review_id = $1 FOR UPDATE',
    [reviewId],
  );
  return rows[0];
}

/** Stores the human decision. A value decided before gets a new mapping version. */
export async function saveMapping(
  client: pg.PoolClient,
  review: ReviewRow,
  normalizedValue: string,
  actor: string,
): Promise<number> {
  const { rows } = await client.query<{ version: number }>(
    `INSERT INTO normalization_mappings
       (source_system, field, raw_value_hash, raw_value, normalized_value, status, approved_by)
     VALUES ($1, $2, $3, $4, $5, 'APPROVED', $6)
     ON CONFLICT (source_system, field, raw_value_hash) DO UPDATE SET
       normalized_value = EXCLUDED.normalized_value, status = 'APPROVED', approved_by = EXCLUDED.approved_by,
       approved_at = now(), version = normalization_mappings.version + 1
     RETURNING version`,
    [review.source_system, review.field, review.raw_value_hash, review.raw_value, normalizedValue, actor],
  );
  return rows[0]!.version;
}

export async function closeReview(
  client: pg.PoolClient,
  reviewId: string,
  input: {
    status: 'APPROVED' | 'REJECTED';
    outcome: 'accepted_as_is' | 'edited' | 'rejected';
    finalValue: string | null;
    reviewer: string;
    rejectReason: string | null;
  },
): Promise<ReviewRow> {
  const { rows } = await client.query<ReviewRow>(
    `UPDATE normalization_review_queue
        SET status = $2, outcome = $3, final_value = $4, reviewed_by = $5, reviewed_at = now(), reject_reason = $6
      WHERE review_id = $1 RETURNING *`,
    [reviewId, input.status, input.outcome, input.finalValue, input.reviewer, input.rejectReason],
  );
  return rows[0]!;
}

export async function waitingRecords(client: pg.PoolClient, reviewId: string): Promise<WaitingRecord[]> {
  const { rows } = await client.query<WaitingRecord>(
    `SELECT record_id, entity_type, entity_id, raw_payload FROM pending_normalized_records
      WHERE review_id = $1 AND status = 'WAITING'
      ORDER BY received_at, record_id FOR UPDATE`,
    [reviewId],
  );
  return rows;
}

export async function markRecords(client: pg.PoolClient, reviewId: string, status: 'APPLIED' | 'MANUAL') {
  await client.query(
    `UPDATE pending_normalized_records SET status = $2 WHERE review_id = $1 AND status = 'WAITING'`,
    [reviewId, status],
  );
}

export interface ProductUpsert {
  sku_id: string;
  name: string;
  category: string | null;
  base_unit: string | null;
  pack_size_verified: string | null;
  unit_price: number;
  status: 'ACTIVE' | 'PENDING_REVIEW';
  source_version: number;
  source_unit: string;
  source_category: string;
  source_description: string;
}

export async function upsertProduct(client: pg.PoolClient, product: ProductUpsert, ignoreVersion: boolean) {
  await client.query(
    `INSERT INTO products (sku_id, name, category, base_unit, pack_size_verified, unit_price, status, source_version,
                           source_unit, source_category, source_description)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (sku_id) DO UPDATE SET
       name = EXCLUDED.name, category = EXCLUDED.category, base_unit = EXCLUDED.base_unit,
       pack_size_verified = EXCLUDED.pack_size_verified, unit_price = EXCLUDED.unit_price,
       status = EXCLUDED.status, source_version = EXCLUDED.source_version, source_unit = EXCLUDED.source_unit,
       source_category = EXCLUDED.source_category, source_description = EXCLUDED.source_description,
       updated_at = now()
     WHERE $12 OR EXCLUDED.source_version >= products.source_version`,
    [
      product.sku_id,
      product.name,
      product.category,
      product.base_unit,
      product.pack_size_verified,
      product.unit_price,
      product.status,
      product.source_version,
      product.source_unit,
      product.source_category,
      product.source_description,
      ignoreVersion,
    ],
  );
}
