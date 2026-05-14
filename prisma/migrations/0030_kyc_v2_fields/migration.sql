-- Migration 0030 — expanded vendor KYC (Phase 1: structured fields, no uploads).
--
-- We are widening the `vendors` row with the structured-data side of the new
-- onboarding form (see /tmp/kyc_new.txt for the source spec). File uploads
-- — ID front/back, selfie, business registration document — land in a
-- follow-up migration once the R2 presign + review flow is designed.
--
-- Compatibility / grandfathering:
--   - Every new column is NULLABLE. Existing vendors do NOT need to re-KYC;
--     the legacy submit path (social handles + agreement) still works.
--   - Every CREATE TYPE / ALTER TABLE uses IF NOT EXISTS guards so a partly
--     applied migration self-heals on retry. Prisma's migrate-deploy still
--     only runs the file once via `_prisma_migrations`, but a hand-roll on
--     staging during incident drill won't fall over.
--
-- Indexes:
--   - Admin filtering by service intent ("show me all vendors who picked
--     Fulfillment-only") and by monthly inventory volume ("show me Bulk
--     shippers") is a regular reviewer task. Two narrow btree indexes —
--     cheap, and they shrink to nothing on rows that haven't filled in
--     the column yet (partial NULL handling).
--   - We don't index id_number / contact_phone — those are looked up by
--     vendor_id (already indexed) on the admin detail page, not searched
--     across vendors.

-- ---------------------------------------------------------------------------
-- 1. Enums. Each one is wrapped in a DO block so the migration is idempotent
--    on a hand-roll. CREATE TYPE has no IF NOT EXISTS in current Postgres.
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE "KycBusinessType" AS ENUM (
    'SOLE_PROPRIETORSHIP',
    'REGISTERED_BUSINESS',
    'LLC',
    'CORPORATION',
    'PARTNERSHIP',
    'OTHER'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "KycIndustry" AS ENUM (
    'FASHION_APPAREL',
    'BEAUTY_COSMETICS',
    'HAIR_WIGS',
    'ELECTRONICS',
    'ACCESSORIES',
    'HOME_GOODS',
    'OTHER'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "KycIdType" AS ENUM (
    'PASSPORT',
    'NATIONAL_ID',
    'DRIVERS_LICENSE'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "KycInventoryVolume" AS ENUM (
    'SMALL_1_10',
    'MEDIUM_11_30',
    'LARGE_31_100',
    'XLARGE_100_PLUS',
    'BULK_PALLET'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "KycOrderVolume" AS ENUM (
    'V_1_20',
    'V_21_100',
    'V_101_500',
    'V_500_PLUS'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "KycServiceIntent" AS ENUM (
    'FULFILLMENT_ONLY',
    'PERSONAL_SHOPPER',
    'BOTH'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Note: Sections 7 (Payment & Wallet) and 8 (Compliance / Signature) from
-- the source spec are intentionally NOT migrated. The KycFundingMethod enum,
-- funding_method_preference, billing_contact_email, compliance_signed_at and
-- compliance_signed_name columns are deliberately omitted so they don't ship.
-- Re-introduce them in a future migration if those sections come back to the
-- wizard.

-- ---------------------------------------------------------------------------
-- 2. Columns. All nullable so the existing vendor rows remain valid and the
--    wizard can persist partial progress on each "Next" click.
-- ---------------------------------------------------------------------------

-- Section 1 — Business
ALTER TABLE "vendors"
  ADD COLUMN IF NOT EXISTS "business_type" "KycBusinessType",
  ADD COLUMN IF NOT EXISTS "business_type_other" TEXT,
  ADD COLUMN IF NOT EXISTS "business_registration_number" TEXT,
  ADD COLUMN IF NOT EXISTS "business_registration_country" CHAR(2),
  ADD COLUMN IF NOT EXISTS "business_industry" "KycIndustry",
  ADD COLUMN IF NOT EXISTS "business_industry_other" TEXT;

-- Section 2 — Primary contact
ALTER TABLE "vendors"
  ADD COLUMN IF NOT EXISTS "contact_full_name" TEXT,
  ADD COLUMN IF NOT EXISTS "contact_position" TEXT,
  ADD COLUMN IF NOT EXISTS "contact_phone" TEXT,
  ADD COLUMN IF NOT EXISTS "contact_address_line1" TEXT,
  ADD COLUMN IF NOT EXISTS "contact_address_line2" TEXT,
  ADD COLUMN IF NOT EXISTS "contact_country" CHAR(2);

-- Section 3 — Identity verification (structured fields only; uploads later)
ALTER TABLE "vendors"
  ADD COLUMN IF NOT EXISTS "id_type" "KycIdType",
  ADD COLUMN IF NOT EXISTS "id_number" TEXT,
  ADD COLUMN IF NOT EXISTS "id_expiration_date" DATE;

-- Section 5 — Inventory
ALTER TABLE "vendors"
  ADD COLUMN IF NOT EXISTS "products_stored_description" TEXT,
  ADD COLUMN IF NOT EXISTS "monthly_inventory_volume" "KycInventoryVolume",
  ADD COLUMN IF NOT EXISTS "monthly_order_volume" "KycOrderVolume",
  ADD COLUMN IF NOT EXISTS "service_intent" "KycServiceIntent";

-- Section 6 — Shipping & operations
ALTER TABLE "vendors"
  ADD COLUMN IF NOT EXISTS "primary_shipping_countries" TEXT,
  ADD COLUMN IF NOT EXISTS "requires_returns_handling" BOOLEAN,
  -- product_hazards is a multi-select. We store it as a native text[] rather
  -- than a junction table because the value set is tiny and fixed (see Zod
  -- enum at the API layer); a sub-table would be over-engineering. Empty
  -- array is allowed; null means "not yet answered".
  ADD COLUMN IF NOT EXISTS "product_hazards" TEXT[];

-- Sections 7 & 8 (Payment & Wallet / Compliance signature) intentionally
-- omitted from this migration — see note near the enum block. No
-- funding_method_preference / billing_contact_email / compliance_signed_*
-- columns are added.

-- ---------------------------------------------------------------------------
-- 3. Indexes — narrow + cheap. Admin filtering on Inventory page + Vendor
--    review queue benefits, normal vendor reads don't pay any cost.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS "vendors_monthly_inventory_volume_idx"
  ON "vendors" ("monthly_inventory_volume")
  WHERE "monthly_inventory_volume" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "vendors_service_intent_idx"
  ON "vendors" ("service_intent")
  WHERE "service_intent" IS NOT NULL;
