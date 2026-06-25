-- Migration 0038 — Storefront integration (ingest orders from a vendor's website).
--
-- Lets a vendor's own web store push paid orders to us automatically instead of
-- the vendor re-keying each one in the portal. Three pieces of state:
--
--   1. vendor_api_keys      — the machine credential the storefront authenticates
--                             with (POST /v1/integration/orders).
--   2. vendors.integration_* — the vendor's default shipping choice for the
--                             automated path (no human is present to pick one).
--   3. orders.source/hold_*  — provenance + the hold lifecycle for orders that
--                             can't allocate immediately (no funds / unmapped SKU),
--                             plus the new ON_HOLD status.
--
-- Backward-compatibility
-- ----------------------
-- * orders.source defaults to 'MANUAL', so every existing order keeps behaving
--   exactly as before (the application only special-cases source = 'API').
-- * hold_reason / source_payload are NULLABLE — no backfill required.
-- * ON_HOLD is APPENDED to OrderStatus; adding an enum value is a non-blocking
--   ALTER in Postgres.
--
-- Concurrency
-- -----------
-- Postgres requires `ALTER TYPE ... ADD VALUE` to run before any DDL that uses
-- the new value, so the enum addition is the first statement (same pattern as
-- migrations 0020 and 0037).

-- 1. Extend OrderStatus with the storefront hold state. ON_HOLD sits before
--    ALLOCATED in the lifecycle: an ingested order parks here until the wallet
--    is funded (INSUFFICIENT_FUNDS) or a SKU is mapped (UNMAPPED_SKU), then is
--    released to ALLOCATED.
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'ON_HOLD';

-- 2. Machine credential for the integration endpoint. Only the public keyId and
--    the SHA-256 hash of the secret are stored; the plaintext key is shown to
--    the vendor once at creation and never persisted. Revocation is a soft
--    delete (revoked_at) so the audit trail and any "created_by_key" lineage
--    survive. ON DELETE CASCADE matches every other vendor-scoped table.
CREATE TABLE "vendor_api_keys" (
  "id"           UUID         NOT NULL DEFAULT gen_random_uuid(),
  "vendor_id"    UUID         NOT NULL,
  "name"         TEXT         NOT NULL,
  "key_id"       TEXT         NOT NULL,
  "secret_hash"  TEXT         NOT NULL,
  "last_used_at" TIMESTAMP(3),
  "revoked_at"   TIMESTAMP(3),
  "created_by"   UUID,
  "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "vendor_api_keys_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "vendor_api_keys_vendor_id_fkey"
    FOREIGN KEY ("vendor_id") REFERENCES "vendors" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "vendor_api_keys_key_id_key" ON "vendor_api_keys" ("key_id");
CREATE INDEX "vendor_api_keys_vendor_id_idx" ON "vendor_api_keys" ("vendor_id");

-- 3. Per-vendor default shipping choice for the automated path. NULL carrier
--    service means "cheapest available" — resolved at ingest time against live
--    rates. Insurance mirrors the per-order toggle on the manual flow.
ALTER TABLE "vendors"
  ADD COLUMN "integration_default_carrier_service" TEXT,
  ADD COLUMN "integration_default_insurance"       BOOLEAN NOT NULL DEFAULT false;

-- 4. Order provenance + hold lifecycle. source drives the admin storefront /
--    held-orders queues; hold_reason is only set while status = ON_HOLD;
--    source_payload retains the normalized inbound order so an admin can
--    resolve a hold without the storefront re-sending.
ALTER TABLE "orders"
  ADD COLUMN "source"         TEXT NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN "hold_reason"    TEXT,
  ADD COLUMN "source_payload" JSONB;

-- 5. Index for the admin storefront + held-order queues, e.g.
--    WHERE source = 'API' AND status = 'ON_HOLD' ORDER BY created_at DESC.
CREATE INDEX "orders_source_status_created_at_idx"
  ON "orders" ("source", "status", "created_at");
