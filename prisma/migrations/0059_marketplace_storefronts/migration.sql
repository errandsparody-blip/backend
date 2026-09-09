-- Migration 0059 — Marketplace / Vendor Storefronts (Phase 1 data model).
--
-- Additive only. No destructive changes, no backfill required: every new column
-- is nullable or has a default, and every new table is independent. Existing
-- fulfillment, wallet, and shopper flows are untouched.
--
-- Idempotent (IF NOT EXISTS everywhere) so a partial/retried Railway deploy is
-- safe to re-run.

-- ---------------------------------------------------------------------------
-- 0. Ledger type for the one-time $50 storefront setup fee. ADD VALUE first
--    (Postgres requires the enum value to exist before anything uses it); the
--    marketplace tables below don't reference it, so this is safe here.
-- ---------------------------------------------------------------------------
ALTER TYPE "LedgerEntryType" ADD VALUE IF NOT EXISTS 'STOREFRONT_FEE';

-- ---------------------------------------------------------------------------
-- 1. products — public catalog + retail pricing + categorisation.
-- ---------------------------------------------------------------------------
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "listed" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "retail_price_cents" INTEGER;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "category" TEXT;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "tags" TEXT[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS "products_vendor_id_listed_status_idx"
  ON "products" ("vendor_id", "listed", "status");
CREATE INDEX IF NOT EXISTS "products_listed_category_idx"
  ON "products" ("listed", "category");

-- ---------------------------------------------------------------------------
-- 2. vendors — storefront handle + gating + one-time-fee flag + feature toggle.
-- ---------------------------------------------------------------------------
ALTER TABLE "vendors" ADD COLUMN IF NOT EXISTS "slug" TEXT;
ALTER TABLE "vendors" ADD COLUMN IF NOT EXISTS "storefront_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "vendors" ADD COLUMN IF NOT EXISTS "storefront_fee_paid_at" TIMESTAMP(3);
ALTER TABLE "vendors" ADD COLUMN IF NOT EXISTS "marketplace_featured" BOOLEAN NOT NULL DEFAULT false;

-- Unique slug (nullable — NULLs are allowed multiple times in Postgres unique).
CREATE UNIQUE INDEX IF NOT EXISTS "vendors_slug_key" ON "vendors" ("slug");

-- ---------------------------------------------------------------------------
-- 3. vendor_storefronts — presentation (1:1 with vendor).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "vendor_storefronts" (
  "vendor_id"    UUID        NOT NULL,
  "display_name" TEXT        NOT NULL,
  "logo_url"     TEXT,
  "banner_url"   TEXT,
  "accent_color" TEXT,
  "about"        TEXT,
  "currency"     TEXT        NOT NULL DEFAULT 'USD',
  "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "vendor_storefronts_pkey" PRIMARY KEY ("vendor_id"),
  CONSTRAINT "vendor_storefronts_vendor_id_fkey"
    FOREIGN KEY ("vendor_id") REFERENCES "vendors" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- ---------------------------------------------------------------------------
-- 4. vendor_payout_accounts — connected Stripe/Paystack destinations.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "vendor_payout_accounts" (
  "id"                  UUID         NOT NULL DEFAULT gen_random_uuid(),
  "vendor_id"           UUID         NOT NULL,
  "processor"           TEXT         NOT NULL,
  "external_account_id" TEXT,
  "status"              TEXT         NOT NULL DEFAULT 'PENDING',
  "details_submitted"   BOOLEAN      NOT NULL DEFAULT false,
  "charges_enabled"     BOOLEAN      NOT NULL DEFAULT false,
  "payouts_enabled"     BOOLEAN      NOT NULL DEFAULT false,
  "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "vendor_payout_accounts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "vendor_payout_accounts_vendor_id_fkey"
    FOREIGN KEY ("vendor_id") REFERENCES "vendors" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "vendor_payout_accounts_vendor_id_processor_key"
  ON "vendor_payout_accounts" ("vendor_id", "processor");
CREATE INDEX IF NOT EXISTS "vendor_payout_accounts_vendor_id_status_idx"
  ON "vendor_payout_accounts" ("vendor_id", "status");

-- ---------------------------------------------------------------------------
-- 5. storefront_orders — the public sale.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "storefront_orders" (
  "id"                     UUID         NOT NULL DEFAULT gen_random_uuid(),
  "reference"              TEXT         NOT NULL,
  "vendor_id"              UUID         NOT NULL,
  "buyer_email"            TEXT         NOT NULL,
  "buyer_name"             TEXT,
  "buyer_phone"            TEXT,
  "ship_address"           JSONB        NOT NULL,
  "items"                  JSONB        NOT NULL,
  "product_subtotal_cents" INTEGER      NOT NULL,
  "discount_code"          TEXT,
  "discount_cents"         INTEGER      NOT NULL DEFAULT 0,
  "shipping_cents"         INTEGER      NOT NULL,
  "shipping_speed"         TEXT         NOT NULL,
  "shipping_service_token" TEXT,
  "platform_fee_cents"     INTEGER      NOT NULL DEFAULT 0,
  "tax_cents"              INTEGER      NOT NULL DEFAULT 0,
  "total_cents"            INTEGER      NOT NULL,
  "currency"               TEXT         NOT NULL DEFAULT 'USD',
  "processor"              TEXT         NOT NULL,
  "payment_ref"            TEXT,
  "payment_intent_id"      TEXT,
  "paid_at"                TIMESTAMP(3),
  "status"                 TEXT         NOT NULL DEFAULT 'PENDING_PAYMENT',
  "fulfillment_order_id"   UUID,
  "tracking_number"        TEXT,
  "carrier"                TEXT,
  "shipped_at"             TIMESTAMP(3),
  "created_at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "storefront_orders_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "storefront_orders_vendor_id_fkey"
    FOREIGN KEY ("vendor_id") REFERENCES "vendors" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "storefront_orders_reference_key"
  ON "storefront_orders" ("reference");
CREATE UNIQUE INDEX IF NOT EXISTS "storefront_orders_fulfillment_order_id_key"
  ON "storefront_orders" ("fulfillment_order_id");
CREATE INDEX IF NOT EXISTS "storefront_orders_vendor_id_status_idx"
  ON "storefront_orders" ("vendor_id", "status");
CREATE INDEX IF NOT EXISTS "storefront_orders_status_created_at_idx"
  ON "storefront_orders" ("status", "created_at");
CREATE INDEX IF NOT EXISTS "storefront_orders_payment_ref_idx"
  ON "storefront_orders" ("payment_ref");

-- Monotonic reference sequence (SF-000001). Application formats the number.
CREATE SEQUENCE IF NOT EXISTS "storefront_order_ref_seq" START 1;

-- ---------------------------------------------------------------------------
-- 6. discount_codes (+ vendor targeting for marketplace codes).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "discount_codes" (
  "id"                 UUID         NOT NULL DEFAULT gen_random_uuid(),
  "code"               TEXT         NOT NULL,
  "scope"              TEXT         NOT NULL,
  "vendor_id"          UUID,
  "created_by"         UUID,
  "discount_type"      TEXT         NOT NULL,
  "value_bps"          INTEGER,
  "value_cents"        INTEGER,
  "active"             BOOLEAN      NOT NULL DEFAULT true,
  "starts_at"          TIMESTAMP(3),
  "ends_at"            TIMESTAMP(3),
  "min_subtotal_cents" INTEGER,
  "max_redemptions"    INTEGER,
  "redemption_count"   INTEGER      NOT NULL DEFAULT 0,
  "created_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "discount_codes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "discount_codes_vendor_id_fkey"
    FOREIGN KEY ("vendor_id") REFERENCES "vendors" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
-- Uniqueness: one code per marketplace, and one code per vendor. Partial
-- unique indexes keep the two namespaces independent (a vendor's "SAVE10"
-- doesn't collide with another vendor's or with a marketplace "SAVE10").
CREATE UNIQUE INDEX IF NOT EXISTS "discount_codes_marketplace_code_key"
  ON "discount_codes" ("code") WHERE "scope" = 'MARKETPLACE';
CREATE UNIQUE INDEX IF NOT EXISTS "discount_codes_vendor_code_key"
  ON "discount_codes" ("vendor_id", "code") WHERE "scope" = 'VENDOR';
CREATE INDEX IF NOT EXISTS "discount_codes_scope_active_idx"
  ON "discount_codes" ("scope", "active");
CREATE INDEX IF NOT EXISTS "discount_codes_vendor_id_active_idx"
  ON "discount_codes" ("vendor_id", "active");

CREATE TABLE IF NOT EXISTS "discount_code_vendors" (
  "discount_code_id" UUID NOT NULL,
  "vendor_id"        UUID NOT NULL,
  CONSTRAINT "discount_code_vendors_pkey" PRIMARY KEY ("discount_code_id", "vendor_id"),
  CONSTRAINT "discount_code_vendors_discount_code_id_fkey"
    FOREIGN KEY ("discount_code_id") REFERENCES "discount_codes" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "discount_code_vendors_vendor_id_fkey"
    FOREIGN KEY ("vendor_id") REFERENCES "vendors" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "discount_code_vendors_vendor_id_idx"
  ON "discount_code_vendors" ("vendor_id");
