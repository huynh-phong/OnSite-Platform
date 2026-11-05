-- OnSite Central: aggregation and monitoring only. Holds no customer names, addresses, contacts or notes.

-- What was received. The primary key is what makes a redelivered event harmless.
CREATE TABLE inbox_events (
  origin_country    TEXT NOT NULL,
  event_id          UUID NOT NULL,
  event_type        TEXT NOT NULL,
  aggregate_type    TEXT NOT NULL,
  aggregate_id      TEXT NOT NULL,
  aggregate_version INTEGER NOT NULL,
  occurred_at       TIMESTAMPTZ NOT NULL,
  -- Filtered through an allow-list on ingest.
  payload           JSONB NOT NULL,
  applied_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- False when a newer version of the order had already arrived.
  projected         BOOLEAN NOT NULL,
  sync_lag_ms       BIGINT NOT NULL,
  PRIMARY KEY (origin_country, event_id)
);
CREATE INDEX inbox_events_applied_idx ON inbox_events (applied_at DESC);

-- The latest known state of each order, only ever moved forward by aggregate_version.
CREATE TABLE order_projection (
  origin_country          TEXT NOT NULL,
  order_id                TEXT NOT NULL,
  version                 INTEGER NOT NULL,
  status                  TEXT NOT NULL,
  sales_store_id          TEXT,
  shipment_count          INTEGER,
  line_count              INTEGER,
  at_risk                 BOOLEAN NOT NULL DEFAULT FALSE,
  early_shortage_detected BOOLEAN NOT NULL DEFAULT FALSE,
  otif                    BOOLEAN,
  eta                     TIMESTAMPTZ,
  requested_delivery_at   TIMESTAMPTZ,
  order_created_at        TIMESTAMPTZ,
  last_event_at           TIMESTAMPTZ NOT NULL,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (origin_country, order_id)
);
CREATE INDEX order_projection_status_idx ON order_projection (status);

CREATE TABLE country_status (
  origin_country           TEXT PRIMARY KEY,
  last_event_occurred_at   TIMESTAMPTZ,
  last_received_at         TIMESTAMPTZ,
  events_received          BIGINT NOT NULL DEFAULT 0,
  duplicate_events_ignored BIGINT NOT NULL DEFAULT 0,
  out_of_order_events      BIGINT NOT NULL DEFAULT 0
);

-- Single row: the simulated ingestion outage.
CREATE TABLE central_settings (
  id                 BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  ingestion_offline  BOOLEAN NOT NULL DEFAULT FALSE,
  refused_while_down BIGINT NOT NULL DEFAULT 0
);
INSERT INTO central_settings DEFAULT VALUES;
