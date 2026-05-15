-- Migration 0031 — drop the KYC v2 `service_intent` column.
--
-- The vendor wizard no longer asks "Fulfillment-only / Personal Shopper /
-- Both" — the product team decided the answer doesn't influence onboarding,
-- and a vendor's actual usage tells us the same thing without needing them
-- to predict it.
--
-- This migration:
--   1. Drops the partial index on `service_intent` (must come before the
--      column drop or Postgres complains about a dependent object).
--   2. Drops the column.
--   3. Drops the enum type, which has no other users — it was created in
--      migration 0030 specifically for this column.
--
-- Compatibility / grandfathering:
--   - The column was nullable from day one (migration 0030), so any
--     existing populated row contains a value we can safely discard
--     instead of preserving. No backfill needed.
--   - The wizard's `inventory` step + the backend's `submitKycV2Schema`
--     have been updated in the same release to stop emitting / requiring
--     `serviceIntent`, so this migration runs at the moment the field
--     stops appearing on the wire.

-- 1. Drop the dependent index (created in migration 0030 line 163-165).
DROP INDEX IF EXISTS "vendors_service_intent_idx";

-- 2. Drop the column.
ALTER TABLE "vendors" DROP COLUMN IF EXISTS "service_intent";

-- 3. Drop the enum. No `IF EXISTS` because Postgres would still warn if
--    the type were referenced elsewhere — at this point it isn't, and a
--    half-applied state on retry would already have errored at step 2.
DROP TYPE IF EXISTS "KycServiceIntent";
