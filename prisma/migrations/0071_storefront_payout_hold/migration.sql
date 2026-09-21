-- 0071 · Delayed vendor payout ("hold before paying") for returns.
--
-- Under collect-then-payout the platform charges the buyer once, then transfers
-- each vendor their product share. To make refunds instant and clawback-free,
-- we now HOLD each vendor's share for the vendor's declared return window
-- instead of paying immediately:
--   payout_status = 'HELD'      → share is held on the platform balance
--   payout_release_at           → when the sweep may release it (window elapsed)
--   payout_status = 'CANCELLED' → order refunded while held; vendor never paid
--
-- A daily release sweep flips HELD → PENDING (then pays) once the window passes
-- and no return is open. Existing values (PENDING/PAID/FAILED) are unchanged;
-- payout_status stays a free-text column, so no enum migration is needed.

ALTER TABLE "storefront_orders"
  ADD COLUMN IF NOT EXISTS "payout_release_at" TIMESTAMP(3);

-- Sweep lookup: held payouts whose release time has passed.
CREATE INDEX IF NOT EXISTS "storefront_orders_payout_release_idx"
  ON "storefront_orders" ("payout_status", "payout_release_at");
