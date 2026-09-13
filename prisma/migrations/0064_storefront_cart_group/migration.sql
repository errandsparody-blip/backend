-- Migration 0064 — cart-group linkage for cross-vendor storefront orders.
-- A single cross-vendor cart is ONE delivery from the warehouse, but it still
-- produces one storefront_order (and one fulfillment order) per vendor so each
-- vendor is paid + tracked independently. This column links those sub-orders so
-- the warehouse can see they ship together and (next step) pack them into one
-- physical shipment/label. NULL for single-store orders. Additive + idempotent.

ALTER TABLE "storefront_orders"
  ADD COLUMN IF NOT EXISTS "cart_group_id" UUID;

CREATE INDEX IF NOT EXISTS "storefront_orders_cart_group_idx"
  ON "storefront_orders" ("cart_group_id");
