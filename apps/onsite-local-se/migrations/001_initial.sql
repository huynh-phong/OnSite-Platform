-- OnSite Local SE: schema for spec section B3.

CREATE FUNCTION forbid_append_only_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------- reference data
CREATE TABLE stores (
  store_id     TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  type         TEXT NOT NULL CHECK (type IN ('STORE', 'HUB')),
  lat          DOUBLE PRECISION NOT NULL,
  lng          DOUBLE PRECISION NOT NULL,
  prep_minutes INTEGER NOT NULL CHECK (prep_minutes > 0),
  status       TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE'))
);

CREATE TABLE customers (
  customer_id   TEXT PRIMARY KEY,
  company_name  TEXT NOT NULL,
  contact_enc   BYTEA NOT NULL,
  contact_nonce BYTEA NOT NULL,
  contact_tag   BYTEA NOT NULL,
  key_id        TEXT NOT NULL
);

CREATE TABLE users (
  user_id       TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('customer', 'staff', 'admin')),
  country       TEXT NOT NULL,
  store_id      TEXT REFERENCES stores (store_id),
  customer_id   TEXT REFERENCES customers (customer_id),
  CHECK (role <> 'staff' OR store_id IS NOT NULL),
  CHECK (role <> 'customer' OR customer_id IS NOT NULL)
);

CREATE TABLE sites (
  site_id       TEXT PRIMARY KEY,
  customer_id   TEXT NOT NULL REFERENCES customers (customer_id),
  lat           DOUBLE PRECISION NOT NULL,
  lng           DOUBLE PRECISION NOT NULL,
  address_enc   BYTEA NOT NULL,
  address_nonce BYTEA NOT NULL,
  address_tag   BYTEA NOT NULL,
  key_id        TEXT NOT NULL
);
CREATE INDEX sites_customer_idx ON sites (customer_id);

-- ---------------------------------------------------------------- catalog and stock
CREATE TABLE products (
  sku_id             TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  -- NULL until normalization of the field has been approved.
  category           TEXT CHECK (category IN ('cement', 'timber', 'gypsum_board', 'insulation', 'other')),
  base_unit          TEXT CHECK (base_unit IN ('bag', 'piece', 'pallet', 'sheet', 'm', 'm2', 'm3', 'kg', 'roll')),
  pack_size_verified NUMERIC(10, 3) CHECK (pack_size_verified > 0),
  unit_price         NUMERIC(12, 2) NOT NULL CHECK (unit_price >= 0),
  status             TEXT NOT NULL DEFAULT 'PENDING_REVIEW' CHECK (status IN ('ACTIVE', 'PENDING_REVIEW')),
  source_version     INTEGER NOT NULL DEFAULT 0,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (status <> 'ACTIVE' OR (category IS NOT NULL AND base_unit IS NOT NULL))
);

CREATE TABLE inventory_view (
  node_id                TEXT NOT NULL REFERENCES stores (store_id),
  sku_id                 TEXT NOT NULL,
  on_hand                INTEGER NOT NULL CHECK (on_hand >= 0),
  reserved               INTEGER NOT NULL CHECK (reserved >= 0),
  source_updated_at      TIMESTAMPTZ NOT NULL,
  ingested_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_version         INTEGER NOT NULL,
  source_unit            TEXT NOT NULL,
  -- TRUE excludes the row from usable stock until its source unit is approved.
  normalization_pending  BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (node_id, sku_id)
);

CREATE TABLE sync_cursors (
  source_system   TEXT NOT NULL,
  stream          TEXT NOT NULL,
  last_seq        BIGINT NOT NULL DEFAULT 0,
  last_attempt_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_error      TEXT,
  PRIMARY KEY (source_system, stream)
);

-- ---------------------------------------------------------------- orders
CREATE SEQUENCE order_number_seq;

CREATE TABLE orders (
  order_id                TEXT PRIMARY KEY CHECK (order_id ~ '^SE-ORD-[0-9]{6,}$'),
  customer_id             TEXT NOT NULL REFERENCES customers (customer_id),
  sales_store_id          TEXT NOT NULL REFERENCES stores (store_id),
  site_id                 TEXT NOT NULL REFERENCES sites (site_id),
  requested_delivery_at   TIMESTAMPTZ NOT NULL,
  status                  TEXT NOT NULL CHECK (status IN (
                            'SUBMITTED', 'ALLOCATING', 'AWAITING_APPROVAL', 'NEEDS_REVIEW',
                            'NEEDS_REALLOCATION', 'APPROVED', 'DISPATCHING', 'DISPATCHED',
                            'DELIVERED', 'EXPIRED', 'CANCELLED')),
  review_reason           TEXT,
  fulfillable_qty         INTEGER CHECK (fulfillable_qty >= 0),
  early_shortage_detected BOOLEAN NOT NULL DEFAULT FALSE,
  inventory_as_of         TIMESTAMPTZ,
  reservation_expires_at  TIMESTAMPTZ,
  eta                     TIMESTAMPTZ,
  at_risk                 BOOLEAN NOT NULL DEFAULT FALSE,
  version                 INTEGER NOT NULL DEFAULT 1,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX orders_customer_created_idx ON orders (customer_id, created_at);
CREATE INDEX orders_status_idx ON orders (status);

CREATE TABLE order_items (
  item_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id   TEXT NOT NULL REFERENCES orders (order_id),
  sku_id     TEXT NOT NULL REFERENCES products (sku_id),
  quantity   INTEGER NOT NULL CHECK (quantity > 0),
  unit       TEXT NOT NULL,
  unit_price NUMERIC(12, 2) NOT NULL CHECK (unit_price >= 0)
);
CREATE INDEX order_items_order_idx ON order_items (order_id);

CREATE TABLE fulfilment_tasks (
  task_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      TEXT NOT NULL REFERENCES orders (order_id),
  node_id       TEXT NOT NULL REFERENCES stores (store_id),
  status        TEXT NOT NULL DEFAULT 'PENDING_APPROVAL' CHECK (status IN (
                  'PENDING_APPROVAL', 'APPROVED', 'DISPATCHED', 'DELIVERED', 'REJECTED', 'EXPIRED')),
  approved_by   TEXT,
  approved_at   TIMESTAMPTZ,
  dispatched_at TIMESTAMPTZ,
  delivered_at  TIMESTAMPTZ,
  delivered_qty INTEGER CHECK (delivered_qty >= 0),
  delivery_note TEXT,
  reject_reason TEXT,
  version       INTEGER NOT NULL DEFAULT 1,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX fulfilment_tasks_node_status_idx ON fulfilment_tasks (node_id, status);
CREATE INDEX fulfilment_tasks_order_idx ON fulfilment_tasks (order_id);
-- One live task per shipping node per order.
CREATE UNIQUE INDEX fulfilment_tasks_one_live_per_node
  ON fulfilment_tasks (order_id, node_id)
  WHERE status NOT IN ('REJECTED', 'EXPIRED');

CREATE TABLE allocations (
  allocation_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id        UUID NOT NULL REFERENCES order_items (item_id),
  task_id        UUID REFERENCES fulfilment_tasks (task_id),
  node_id        TEXT NOT NULL REFERENCES stores (store_id),
  quantity       INTEGER NOT NULL CHECK (quantity > 0),
  routing_reason TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'RELEASED')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX allocations_item_idx ON allocations (item_id);
CREATE INDEX allocations_task_idx ON allocations (task_id);

CREATE TABLE reservations (
  reservation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  allocation_id  UUID NOT NULL REFERENCES allocations (allocation_id),
  external_ref   TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('ACTIVE', 'COMMITTED', 'RELEASED', 'EXPIRED')),
  expires_at     TIMESTAMPTZ NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX reservations_status_expires_idx ON reservations (status, expires_at);
CREATE INDEX reservations_allocation_idx ON reservations (allocation_id);

CREATE TABLE shipments (
  shipment_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id       UUID NOT NULL UNIQUE REFERENCES fulfilment_tasks (task_id),
  dispatch_slot TIMESTAMPTZ,
  eta           TIMESTAMPTZ,
  eta_inputs    JSONB,
  is_short      BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE order_events (
  order_event_id BIGSERIAL PRIMARY KEY,
  order_id       TEXT NOT NULL REFERENCES orders (order_id),
  version        INTEGER NOT NULL,
  type           TEXT NOT NULL,
  actor          TEXT NOT NULL,
  occurred_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  data           JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX order_events_order_idx ON order_events (order_id, order_event_id);
CREATE TRIGGER order_events_append_only
  BEFORE UPDATE OR DELETE ON order_events
  FOR EACH ROW EXECUTE FUNCTION forbid_append_only_mutation();

CREATE TABLE idempotency_records (
  principal_id TEXT NOT NULL,
  key          TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status_code  INTEGER,
  response     JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  UNIQUE (principal_id, key)
);

-- ---------------------------------------------------------------- integration
CREATE TABLE outbox_events (
  outbox_id         BIGSERIAL PRIMARY KEY,
  event_id          UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  origin_country    TEXT NOT NULL,
  aggregate_type    TEXT NOT NULL,
  aggregate_id      TEXT NOT NULL,
  aggregate_version INTEGER NOT NULL,
  event_type        TEXT NOT NULL,
  payload           JSONB NOT NULL,
  occurred_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  status            TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'DELIVERED', 'DEAD')),
  retry_count       INTEGER NOT NULL DEFAULT 0,
  next_attempt_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at      TIMESTAMPTZ
);
CREATE INDEX outbox_events_status_next_attempt_idx ON outbox_events (status, next_attempt_at);
CREATE INDEX outbox_events_aggregate_idx ON outbox_events (aggregate_id);

CREATE TABLE inbox_events (
  source_system   TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_system, source_event_id)
);

-- ---------------------------------------------------------------- normalization
CREATE TABLE normalization_mappings (
  mapping_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_system    TEXT NOT NULL,
  field            TEXT NOT NULL CHECK (field IN ('unit', 'category', 'pack_size_kg')),
  raw_value_hash   TEXT NOT NULL,
  raw_value        TEXT NOT NULL,
  normalized_value TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'APPROVED' CHECK (status IN ('APPROVED', 'RETIRED')),
  approved_by      TEXT NOT NULL,
  approved_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  version          INTEGER NOT NULL DEFAULT 1,
  UNIQUE (source_system, field, raw_value_hash)
);

CREATE TABLE normalization_review_queue (
  review_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_system        TEXT NOT NULL,
  field                TEXT NOT NULL CHECK (field IN ('unit', 'category', 'pack_size_kg')),
  raw_value_hash       TEXT NOT NULL,
  raw_value            TEXT NOT NULL,
  ai_suggestion        TEXT,
  confidence           NUMERIC(4, 3) CHECK (confidence BETWEEN 0 AND 1),
  ai_reason            TEXT,
  ai_evidence          TEXT,
  model_version        TEXT,
  pending_record_count INTEGER NOT NULL DEFAULT 0 CHECK (pending_record_count >= 0),
  status               TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  outcome              TEXT CHECK (outcome IN ('accepted_as_is', 'edited', 'rejected')),
  final_value          TEXT,
  reviewed_by          TEXT,
  reviewed_at          TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX normalization_review_one_pending
  ON normalization_review_queue (source_system, field, raw_value_hash)
  WHERE status = 'PENDING';

CREATE TABLE pending_normalized_records (
  record_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id   UUID NOT NULL REFERENCES normalization_review_queue (review_id),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('product', 'inventory')),
  entity_id   TEXT NOT NULL,
  raw_payload JSONB NOT NULL,
  status      TEXT NOT NULL DEFAULT 'WAITING' CHECK (status IN ('WAITING', 'APPLIED', 'MANUAL')),
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX pending_normalized_records_review_idx ON pending_normalized_records (review_id, received_at);
CREATE INDEX pending_normalized_records_entity_idx ON pending_normalized_records (entity_type, entity_id);

-- ---------------------------------------------------------------- audit
CREATE TABLE audit_logs (
  audit_id    BIGSERIAL PRIMARY KEY,
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  resource    TEXT NOT NULL,
  result      TEXT NOT NULL,
  request_id  TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER audit_logs_append_only
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION forbid_append_only_mutation();
