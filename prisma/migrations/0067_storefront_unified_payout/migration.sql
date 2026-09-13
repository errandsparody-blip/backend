-- Migration 0067 — unified cart payment (collect-then-payout) tracking.
-- When the platform collects ONE charge for a multi-vendor cart, each sub-order
-- is paid out to its vendor by a separate transfer. These columns track that:
--   collector_processor — the rail that took the single platform charge (NULL
--                         for ordinary direct-charge orders).
--   payout_status       — the vendor transfer state for this sub-order:
--                         NONE (direct charge, no transfer needed) | PENDING |
--                         PAID | FAILED.
--   payout_transfer_id  — the processor transfer id once paid out.
-- Additive + idempotent; all default to the direct-charge behaviour so existing
-- and per-vendor orders are unaffected.

ALTER TABLE "storefront_orders"
  ADD COLUMN IF NOT EXISTS "collector_processor" TEXT,
  ADD COLUMN IF NOT EXISTS "payout_status" TEXT NOT NULL DEFAULT 'NONE',
  ADD COLUMN IF NOT EXISTS "payout_transfer_id" TEXT;

-- Sweep failed/pending payouts by cart group efficiently.
CREATE INDEX IF NOT EXISTS "storefront_orders_payout_status_idx"
  ON "storefront_orders" ("payout_status");
