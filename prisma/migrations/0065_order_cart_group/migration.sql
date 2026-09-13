-- Migration 0065 — cart-group + consolidation columns on fulfillment orders.
-- A cross-vendor cart produces one fulfillment order per vendor. These columns
-- let the warehouse pack the group as ONE physical shipment: the primary order
-- carries the label; secondaries reference it and ship on the same tracking
-- number. This migration adds ONLY the columns (the consolidation logic that
-- writes consolidated_into_order_id / is_consolidated_primary is shipped +
-- tested separately). cart_group_id is populated now, at fulfillment creation,
-- copied from the storefront order. Additive + idempotent.

ALTER TABLE "orders"
  ADD COLUMN IF NOT EXISTS "cart_group_id" UUID,
  ADD COLUMN IF NOT EXISTS "consolidated_into_order_id" UUID,
  ADD COLUMN IF NOT EXISTS "is_consolidated_primary" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "orders_cart_group_idx" ON "orders" ("cart_group_id");
