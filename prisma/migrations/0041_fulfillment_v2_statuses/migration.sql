-- Migration 0041 — Fulfillment v2: order statuses + estimate columns + feature flag.
--
-- Phase B of the workflow redesign. Ships the schema changes needed for
-- the new create path (workflowVersion=2). The runtime switch stays OFF
-- until Phase C's admin pack flow is live and a SUPER_ADMIN flips the
-- `fulfillment_v2_enabled` config row to true.
--
-- Additive; no existing behaviour changes. Every migration statement here
-- is a column add, enum-value add, or config insert. No column drops, no
-- data mutation.
--
-- What lands:
--
--   1. Five new OrderStatus enum values covering the v2 status flow:
--        PENDING_PACKING            — order accepted, warehouse hasn't started
--        PACKING_COMPLETED          — warehouse packed, waiting for admin to pick a rate
--        AWAITING_SHIPPING_SELECTION— admin can retrieve live Shippo rates
--        AWAITING_WALLET_FUNDING    — packed + rate picked, but wallet couldn't cover
--        SHIPPING_PAID              — wallet debited, ready to buy label
--      (COMPLETED already exists as DELIVERED — no need to duplicate.)
--
--      Note: HANDED_OFF from migration 0037 stays as-is for the VENDOR_CARRIER
--      terminal state. LABEL_PURCHASED / SHIPPED / IN_TRANSIT / DELIVERED /
--      EXCEPTION / CANCELLED / RETURNED are all unchanged.
--
--   2. Two new nullable Order columns for the vendor-facing estimate:
--        estimated_shipping_min_cents  — bottom of the range shown at submit
--        estimated_shipping_max_cents  — top of the range; also the number
--                                        wallet-cover validation must exceed
--      Both NULL for workflowVersion=1 orders (legacy flow doesn't need them).
--
--   3. Config row `fulfillment_v2_enabled` seeded to `false`. When true,
--      OrderService.create dispatches to the v2 path (skip Shippo quote,
--      debit fulfillment fee only, status=PENDING_PACKING). SUPER_ADMIN
--      toggles from the admin config page.
--
-- Rollback safety: the columns are nullable and the enum values are additive
-- (no existing rows use them). Dropping the config row is safe; the loader
-- falls back to `false`, restoring the legacy flow instantly.

-- New OrderStatus enum values. IF NOT EXISTS is idempotent — re-running
-- the migration on a database that already has these values is a no-op.
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'PENDING_PACKING';
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'PACKING_COMPLETED';
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'AWAITING_SHIPPING_SELECTION';
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'AWAITING_WALLET_FUNDING';
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'SHIPPING_PAID';

-- Estimated shipping range stored at submit time. Populated only when
-- the order is created under workflowVersion=2. Nullable so existing
-- rows backfill to NULL without a table rewrite.
ALTER TABLE "orders"
  ADD COLUMN "estimated_shipping_min_cents" INTEGER,
  ADD COLUMN "estimated_shipping_max_cents" INTEGER;

-- Feature flag. Default false = keep every submit on the legacy flow
-- until Phase C's admin pack pipeline is live and finance flips this
-- to true. See OrderService.create for the dispatch logic.
INSERT INTO "configuration" ("key", "value", "description", "updated_at")
VALUES (
  'fulfillment_v2_enabled',
  'false'::jsonb,
  'Fulfillment v2 kill-switch. When true, new orders enter the v2 flow (workflowVersion=2, status=PENDING_PACKING, fulfillment fee debited only). When false (default), the legacy Shippo-quote-at-submit flow stays in effect. Toggle after the admin pack pipeline (Phase C) is live. Editable by super admin.',
  NOW()
)
ON CONFLICT ("key") DO NOTHING;
