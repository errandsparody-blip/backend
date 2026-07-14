-- Migration 0043 — Packaging library (Fulfillment v2).
--
-- Shared, admin-maintained catalog of shippable box / mailer presets.
-- The warehouse pack step reads from this table so an operator can
-- pick "Medium Flat Rate Box" instead of typing 11 × 8.5 × 5.5.
-- Selecting a preset:
--   * Populates the pack-time dims (length/width/height) automatically.
--   * Adds `tare_weight_oz` to the operator-entered goods weight so
--     the parcel weight sent to Shippo includes the box's own weight.
--
-- The `orders.packaging_option_id` FK is set only when a preset was
-- chosen. Ad-hoc box dimensions (operator typed everything) leave it
-- NULL. ON DELETE SET NULL so retiring a preset never breaks
-- historical order rows.
--
-- Seeded presets mirror the four USPS flat-rate containers already
-- referenced in the Shippo integration + one generic 12" cube fallback
-- and one 6"×4"×2" small mailer, so the pack UI has SOMETHING sensible
-- to show on first boot. Admins can add / edit / deactivate later
-- from /admin/config/packaging.
--
-- Bounds:
--   * length/width/height decimal(6,1), CHECK > 0, CHECK ≤ 48
--   * tare_weight_oz integer, CHECK ≥ 0, CHECK ≤ 400 (25 lb — well
--     under the flat-rate 70 lb cap so a bad tare can't sink the
--     billing weight math).
--   * code matches [a-z0-9_-]{2,32} (URL-safe, upper-cased forbidden
--     to keep API paths canonical).
--   * label VARCHAR(80) — short enough for the pack modal dropdown.

BEGIN;

CREATE TABLE "packaging_options" (
  "id"              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "code"            VARCHAR(32) NOT NULL,
  "label"           VARCHAR(80) NOT NULL,
  "length_in"       DECIMAL(6, 1) NOT NULL,
  "width_in"        DECIMAL(6, 1) NOT NULL,
  "height_in"       DECIMAL(6, 1) NOT NULL,
  "tare_weight_oz"  INTEGER NOT NULL DEFAULT 0,
  "is_active"       BOOLEAN NOT NULL DEFAULT TRUE,
  "sort_order"      INTEGER NOT NULL DEFAULT 100,
  "created_at"      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at"      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "packaging_options_code_unique" UNIQUE ("code"),
  CONSTRAINT "packaging_options_code_format"
    CHECK ("code" ~ '^[a-z0-9_-]{2,32}$'),
  CONSTRAINT "packaging_options_dims_positive"
    CHECK (
      "length_in" > 0 AND "length_in" <= 48 AND
      "width_in"  > 0 AND "width_in"  <= 48 AND
      "height_in" > 0 AND "height_in" <= 48
    ),
  CONSTRAINT "packaging_options_tare_bounds"
    CHECK ("tare_weight_oz" >= 0 AND "tare_weight_oz" <= 400)
);

-- Sort_order + active mirror the UX filter/order: active options first,
-- then by sort_order. The composite index supports the picker's most
-- common query without a full scan.
CREATE INDEX "packaging_options_active_sort_idx"
  ON "packaging_options" ("is_active", "sort_order", "label");

-- Optional FK on orders. NULL = ad-hoc dims (operator typed everything);
-- SET NULL on delete so retiring a preset never nulls out historical
-- pack data (dims stay on the order row via packed_*_in columns).
ALTER TABLE "orders"
  ADD COLUMN "packaging_option_id" UUID
    REFERENCES "packaging_options"("id") ON DELETE SET NULL;

CREATE INDEX "orders_packaging_option_id_idx"
  ON "orders" ("packaging_option_id");

-- ---------------------------------------------------------------------
-- Seed presets. Codes are stable — the pack UI references them by
-- code, and the pricing engine may key off of them for lane-specific
-- billing (flat-rate boxes bill differently from weight-based).
-- ---------------------------------------------------------------------
INSERT INTO "packaging_options"
  ("code", "label", "length_in", "width_in", "height_in", "tare_weight_oz", "sort_order")
VALUES
  ('mailer_small',    'Small padded mailer (6 × 4 × 2 in)',       6.0,  4.0,  2.0,  1,  10),
  ('usps_flat_env',   'USPS Flat Rate Envelope',                  12.5, 9.5,  0.7,  1,  20),
  ('usps_flat_small', 'USPS Small Flat Rate Box',                 8.6,  5.4,  1.6,  4,  30),
  ('usps_flat_med',   'USPS Medium Flat Rate Box',                11.0, 8.5,  5.5,  8,  40),
  ('usps_flat_large', 'USPS Large Flat Rate Box',                 12.0, 12.0, 5.5, 16,  50),
  ('cube_12',         'Generic cube (12 × 12 × 12 in)',           12.0, 12.0, 12.0, 8,  60)
ON CONFLICT ("code") DO NOTHING;

COMMIT;
