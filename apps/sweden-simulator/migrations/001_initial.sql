-- Sweden Legacy Simulator: stands in for the retailer's existing ERP/WMS.

CREATE TABLE stores (
  store_id     TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  type         TEXT NOT NULL CHECK (type IN ('STORE', 'HUB')),
  lat          DOUBLE PRECISION NOT NULL,
  lng          DOUBLE PRECISION NOT NULL,
  prep_minutes INTEGER NOT NULL CHECK (prep_minutes > 0),
  status       TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE'))
);

CREATE TABLE products (
  sku_id             TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  source_unit        TEXT NOT NULL,
  source_category    TEXT NOT NULL,
  source_description TEXT NOT NULL,
  unit_price_sek     NUMERIC(12, 2) NOT NULL CHECK (unit_price_sek >= 0),
  version            INTEGER NOT NULL DEFAULT 1,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE inventory (
  node_id     TEXT NOT NULL REFERENCES stores (store_id),
  sku_id      TEXT NOT NULL REFERENCES products (sku_id),
  on_hand     INTEGER NOT NULL CHECK (on_hand >= 0),
  reserved    INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  -- The unit this node's system reports in; may differ per node (Store C uses "st").
  source_unit TEXT NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (node_id, sku_id)
);

CREATE TABLE reservations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id         TEXT NOT NULL,
  sku_id          TEXT NOT NULL,
  qty             INTEGER NOT NULL CHECK (qty > 0),
  status          TEXT NOT NULL DEFAULT 'ACTIVE'
                    CHECK (status IN ('ACTIVE', 'COMMITTED', 'RELEASED', 'EXPIRED')),
  expires_at      TIMESTAMPTZ NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (node_id, sku_id) REFERENCES inventory (node_id, sku_id)
);
CREATE INDEX reservations_status_expires_idx ON reservations (status, expires_at);

CREATE TABLE stock_ledger (
  entry_id    BIGSERIAL PRIMARY KEY,
  node_id     TEXT NOT NULL,
  sku_id      TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('INBOUND', 'OUTBOUND')),
  qty         INTEGER NOT NULL CHECK (qty > 0),
  reference   TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX stock_ledger_node_sku_idx ON stock_ledger (node_id, sku_id);

CREATE FUNCTION forbid_ledger_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'stock_ledger is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER stock_ledger_append_only
  BEFORE UPDATE OR DELETE ON stock_ledger
  FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation();

CREATE TABLE change_feed (
  seq        BIGSERIAL PRIMARY KEY,
  entity     TEXT NOT NULL CHECK (entity IN ('product', 'inventory')),
  entity_id  TEXT NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX change_feed_entity_seq_idx ON change_feed (entity, seq);

-- Single row holding the simulated outage switch.
CREATE TABLE sim_settings (
  id             BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  outage_enabled BOOLEAN NOT NULL DEFAULT FALSE
);
