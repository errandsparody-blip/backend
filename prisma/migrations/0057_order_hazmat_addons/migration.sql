-- Migration 0057 — additional vendor/operator label add-ons that affect
-- carrier rates: alcohol, dry ice, and lithium batteries. Applied as Shippo
-- shipment `extra` at rate time so the price reflects them and the purchased
-- label carries them. Idempotent so a re-run can't wedge the deploy.
ALTER TABLE "orders"
  ADD COLUMN IF NOT EXISTS "contains_alcohol"       BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "alcohol_recipient_type" VARCHAR(16),
  ADD COLUMN IF NOT EXISTS "contains_dry_ice"       BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "dry_ice_weight_oz"      INTEGER,
  ADD COLUMN IF NOT EXISTS "contains_lithium"       BOOLEAN NOT NULL DEFAULT false;
