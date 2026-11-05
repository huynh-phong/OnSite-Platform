-- Additive: reservation renewal, feed continuity checks, full stock ledger.

ALTER TABLE reservations
  ADD COLUMN extended_at     TIMESTAMPTZ,
  ADD COLUMN extension_count INTEGER NOT NULL DEFAULT 0;

-- Every stock movement is recorded, not only physical inbound and outbound.
ALTER TABLE stock_ledger DROP CONSTRAINT stock_ledger_type_check;
ALTER TABLE stock_ledger ADD CONSTRAINT stock_ledger_type_check
  CHECK (type IN ('INBOUND', 'OUTBOUND', 'RESERVE', 'RELEASE', 'EXPIRE'));

ALTER TABLE inventory ADD CONSTRAINT inventory_reserved_within_on_hand CHECK (reserved <= on_hand);

-- feed_epoch changes on reseed so consumers can detect that their cursor no longer applies.
-- feed_trimmed_through is the highest change_feed.seq that was removed.
ALTER TABLE sim_settings
  ADD COLUMN feed_epoch           UUID NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN feed_trimmed_through BIGINT NOT NULL DEFAULT 0;
