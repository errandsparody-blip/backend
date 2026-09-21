-- 0072 · Self-service returns: tracking + warehouse receipt.
--
-- Buyers start a return by entering the tracking number of the parcel they've
-- sent back to USA Errands; the warehouse marks it received before an admin
-- approves the refund. Additive + idempotent.

ALTER TABLE "storefront_return_requests"
  ADD COLUMN IF NOT EXISTS "return_tracking_number" TEXT,
  ADD COLUMN IF NOT EXISTS "received_at"            TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "received_by"            UUID;
