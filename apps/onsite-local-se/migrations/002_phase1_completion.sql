-- Additive changes for inventory trust, reservation renewal, AI claims and operations.

-- ---------------------------------------------------------------- inventory trust
-- last_successful_sync_at = the last time the complete change feed was checked and verified.
-- It is separate from source_updated_at and ingested_at on inventory_view, which only move
-- when a row actually changes at the source.
ALTER TABLE sync_cursors RENAME COLUMN last_success_at TO last_successful_sync_at;
ALTER TABLE sync_cursors
  ADD COLUMN feed_epoch           TEXT,
  ADD COLUMN source_head_seq      BIGINT,
  ADD COLUMN continuity_ok        BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0;

ALTER TABLE inventory_view ADD COLUMN normalized_unit TEXT;

ALTER TABLE products
  ADD COLUMN source_unit        TEXT,
  ADD COLUMN source_category    TEXT,
  ADD COLUMN source_description TEXT;

-- Admin switch for the source connector.
CREATE TABLE connector_settings (
  source_system TEXT PRIMARY KEY,
  enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by    TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- orders and tasks
ALTER TABLE orders
  ADD COLUMN approved_at    TIMESTAMPTZ,
  ADD COLUMN delivered_at   TIMESTAMPTZ,
  ADD COLUMN otif           BOOLEAN,
  ADD COLUMN at_risk_reason TEXT;

-- A cancelled or expired order must close its tasks, including ones already approved.
ALTER TABLE fulfilment_tasks DROP CONSTRAINT fulfilment_tasks_status_check;
ALTER TABLE fulfilment_tasks ADD CONSTRAINT fulfilment_tasks_status_check CHECK (status IN (
  'PENDING_APPROVAL', 'APPROVED', 'DISPATCHED', 'DELIVERED', 'REJECTED', 'EXPIRED', 'CANCELLED'));
DROP INDEX fulfilment_tasks_one_live_per_node;
CREATE UNIQUE INDEX fulfilment_tasks_one_live_per_node
  ON fulfilment_tasks (order_id, node_id)
  WHERE status NOT IN ('REJECTED', 'EXPIRED', 'CANCELLED');

ALTER TABLE idempotency_records ADD COLUMN order_id TEXT REFERENCES orders (order_id);

-- ---------------------------------------------------------------- reservations
-- PENDING: the call to the source is about to be made, so a crash can be cleaned up by key.
-- RELEASING: the release is decided and durable; it is retried until the source confirms.
ALTER TABLE reservations DROP CONSTRAINT reservations_status_check;
ALTER TABLE reservations ADD CONSTRAINT reservations_status_check CHECK (status IN (
  'PENDING', 'ACTIVE', 'RELEASING', 'COMMITTED', 'RELEASED', 'EXPIRED'));
ALTER TABLE reservations ALTER COLUMN external_ref DROP NOT NULL;
ALTER TABLE reservations
  ADD COLUMN idempotency_key   TEXT UNIQUE,
  ADD COLUMN last_renewed_at   TIMESTAMPTZ,
  ADD COLUMN renewal_attempts  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN renewal_error     TEXT,
  ADD COLUMN renewal_failed_at TIMESTAMPTZ;

-- ---------------------------------------------------------------- AI normalization
-- The review row is the claim: it is inserted (QUEUED) before any AI call, and a worker atomically
-- moves it to IN_PROGRESS under a lease. An interrupted call is recovered when the lease runs out.
ALTER TABLE normalization_review_queue
  ADD COLUMN ai_status          TEXT NOT NULL DEFAULT 'COMPLETED'
    CHECK (ai_status IN ('QUEUED', 'IN_PROGRESS', 'COMPLETED', 'FAILED')),
  ADD COLUMN ai_claim_token     UUID,
  ADD COLUMN ai_claimed_at      TIMESTAMPTZ,
  ADD COLUMN ai_attempts        INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN source_description TEXT,
  ADD COLUMN reject_reason      TEXT;
CREATE INDEX normalization_review_ai_queue_idx ON normalization_review_queue (ai_status, ai_claimed_at)
  WHERE status = 'PENDING';

ALTER TABLE normalization_mappings ADD COLUMN hit_count BIGINT NOT NULL DEFAULT 0;

-- A record re-sent while waiting replaces its payload instead of counting twice.
CREATE UNIQUE INDEX pending_records_one_open_per_entity
  ON pending_normalized_records (review_id, entity_type, entity_id)
  WHERE status IN ('WAITING', 'MANUAL');

-- ---------------------------------------------------------------- metrics
-- In the database so that counters survive restarts and stay correct across workers.
CREATE TABLE metric_counters (
  name  TEXT PRIMARY KEY,
  value BIGINT NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------- outbox
-- Retries for a Central that is down never end; only repeated refusals of an event make it DEAD.
ALTER TABLE outbox_events ADD COLUMN non_retryable_failures INTEGER NOT NULL DEFAULT 0;
