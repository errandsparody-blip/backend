-- Migration 0086 — direct WooCommerce webhook token.
--
-- Per-vendor unguessable token embedded in the WooCommerce webhook Delivery URL
-- so a store can POST orders straight to USA Errands with no middleman
-- (Shipbubble). NULL until the vendor connects WooCommerce; rotatable.
ALTER TABLE "vendors"
  ADD COLUMN IF NOT EXISTS "woocommerce_webhook_token" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "vendors_woocommerce_webhook_token_key"
  ON "vendors" ("woocommerce_webhook_token");
