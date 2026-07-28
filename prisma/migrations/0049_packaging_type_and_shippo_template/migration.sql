-- Migration 0049 — Packaging type + Shippo template wiring.
--
-- Extends the packaging library (migration 0043) to distinguish poly
-- mailers from boxes, and to carry a Shippo parcel-template id so the
-- rate-fetch step can request flat-rate / one-rate / simple-rate
-- pricing from carriers instead of always falling back to weight-based
-- rates.
--
-- Also adds an order-level `parcel_template` column so the value the
-- warehouse operator selected at pack time flows through unchanged to
-- the rate request and later the label purchase.
--
-- SOLID / correctness
--   * PackagingType is a Postgres ENUM so the pack UI can render
--     type-specific inputs (poly mailer → L+W required, box → L+W+H
--     required) without a magic-string mismatch between client and
--     server.
--   * `shippo_template` regex-CHECKed so a bad string can't sneak in
--     via a manual PATCH and 500 the Shippo rate request later.
--   * Both new columns are nullable — existing rows behave exactly
--     as before (default to BOX, no template). The application layer
--     upgrades a row to POLY_MAILER or attaches a template as an
--     explicit act.

BEGIN;

-- ---------------------------------------------------------------------
-- 1. PackagingType enum + column on packaging_options
-- ---------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PackagingType') THEN
    CREATE TYPE "PackagingType" AS ENUM ('POLY_MAILER', 'BOX');
  END IF;
END $$;

ALTER TABLE "packaging_options"
  ADD COLUMN "packaging_type" "PackagingType" NOT NULL DEFAULT 'BOX';

-- Seeded USPS Flat Rate Envelope is functionally a poly mailer for
-- input-form purposes (flat, L+W dominate; the 0.7" height is a floor).
-- Same for the small padded mailer seed.
UPDATE "packaging_options"
   SET "packaging_type" = 'POLY_MAILER'
 WHERE "code" IN ('mailer_small', 'usps_flat_env');

-- ---------------------------------------------------------------------
-- 2. shippo_template on packaging_options + backfill seeded USPS presets
-- ---------------------------------------------------------------------

ALTER TABLE "packaging_options"
  ADD COLUMN "shippo_template" VARCHAR(60);

-- Only Shippo's built-in carrier templates get a non-null value. Custom
-- presets (mailer_small, cube_12) stay NULL and get weight-based rates.
UPDATE "packaging_options"
   SET "shippo_template" = 'USPS_FlatRateEnvelope'
 WHERE "code" = 'usps_flat_env';
UPDATE "packaging_options"
   SET "shippo_template" = 'USPS_SmallFlatRateBox'
 WHERE "code" = 'usps_flat_small';
UPDATE "packaging_options"
   SET "shippo_template" = 'USPS_MediumFlatRateBox1'
 WHERE "code" = 'usps_flat_med';
UPDATE "packaging_options"
   SET "shippo_template" = 'USPS_LargeFlatRateBox'
 WHERE "code" = 'usps_flat_large';

-- Format guard: Shippo template ids are alnum + underscore, up to 60
-- chars (their longest current template is around 30). Nullable rows
-- (custom presets) are exempted so the check is a no-op for them.
ALTER TABLE "packaging_options"
  ADD CONSTRAINT "packaging_options_shippo_template_format"
  CHECK (
    "shippo_template" IS NULL
    OR "shippo_template" ~ '^[A-Za-z0-9_]{2,60}$'
  );

-- ---------------------------------------------------------------------
-- 3. parcel_template on orders — the template chosen at pack time
-- ---------------------------------------------------------------------

ALTER TABLE "orders"
  ADD COLUMN "parcel_template" VARCHAR(60);

ALTER TABLE "orders"
  ADD CONSTRAINT "orders_parcel_template_format"
  CHECK (
    "parcel_template" IS NULL
    OR "parcel_template" ~ '^[A-Za-z0-9_]{2,60}$'
  );

COMMIT;
