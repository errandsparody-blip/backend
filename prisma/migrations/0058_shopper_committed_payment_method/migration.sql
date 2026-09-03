-- Migration 0058 — committed payment method on the shopper manual/WIRE rail.
--
-- Once a buyer confirms a specific payment method we email them the payment
-- details, so from that moment the choice is hard-locked: they cannot switch
-- to another method (which is how a card payment previously ended up recorded
-- against the WIRE rail). `committed_payment_method_code` also reflects HOW the
-- buyer actually paid, and `payment_committed_at` flags that details were
-- released to them. Both nullable; historical rows stay null (never committed).
--
-- Idempotent (ADD COLUMN IF NOT EXISTS) so a partial/retried deploy is safe.
ALTER TABLE "shopper_requests"
  ADD COLUMN IF NOT EXISTS "committed_payment_method_code" TEXT;
ALTER TABLE "shopper_requests"
  ADD COLUMN IF NOT EXISTS "payment_committed_at" TIMESTAMP(3);
