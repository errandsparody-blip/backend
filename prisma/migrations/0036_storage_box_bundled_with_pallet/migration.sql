-- Migration 0036 — Bundled-with-pallet boxes
--
-- Lets a StorageBox row represent a box that physically exists but is
-- NOT billed independently because it rides inside an existing pallet
-- the vendor already pays for. That's the ADD_TO_PALLET shipping mode.
--
-- Convention going forward:
--   * `next_billing_date IS NULL` → bundled with a parent pallet,
--     billing cron skips it, but it's still visible to vendor + admin
--     so they can see the inventory they paid stocking on.
--   * `next_billing_date IS NOT NULL` → bills on/after that date.
--
-- This also fixes a latent double-billing bug introduced by migration
-- 0035. That backfill seeded one StorageBox per declared box for every
-- received PSN — including ADD_TO_PALLET ones — and gave each a real
-- next_billing_date. Combined with the parent pallet's own $45/mo
-- billing line, vendors with rolled-up pallet PSNs would have been
-- charged twice on the next cycle. The corrective backfill below
-- nulls those dates out before the next cron run.
--
-- Idempotent: ALTER COLUMN to nullable is a no-op on replay; the
-- corrective UPDATE is a no-op once dates are already null.

-- 1. Make next_billing_date nullable. The default-less ALTER is safe
--    because every existing row already has a non-null value.
ALTER TABLE "storage_boxes"
  ALTER COLUMN "next_billing_date" DROP NOT NULL;

-- 2. Drop and recreate the (status, next_billing_date) index so the
--    cron query (`WHERE next_billing_date <= today`) still has an
--    index it can use after the column became nullable. Btree indexes
--    in Postgres already handle nullable columns, so the recreate is
--    only here to keep the comment & ordering consistent with 0035.
--    Replay-safe via IF EXISTS / IF NOT EXISTS.
DROP INDEX IF EXISTS "storage_boxes_status_next_billing_date_idx";
CREATE INDEX IF NOT EXISTS "storage_boxes_status_next_billing_date_idx"
  ON "storage_boxes" ("status", "next_billing_date")
  WHERE "next_billing_date" IS NOT NULL;

-- 3. Corrective backfill — for every StorageBox whose owning PSN is
--    ADD_TO_PALLET, null out next_billing_date so the cron skips it.
--    This prevents the migration-0035 double-bill for pre-existing
--    rolled-up boxes.
UPDATE "storage_boxes" sb
SET "next_billing_date" = NULL,
    "updated_at"        = now()
FROM "psns" p
WHERE p."id" = sb."psn_id"
  AND p."shipping_mode" = 'ADD_TO_PALLET'
  AND sb."next_billing_date" IS NOT NULL;

-- 4. Corrective backfill — for PALLET shipments, the inner-tier rows
--    (LARGE / MEDIUM / SMALL / X_LARGE) ride inside the pallet's
--    $45/mo billing line and must not bill independently. The 0035
--    backfill (and the receive flow before this migration's companion
--    code change) seeded one independent billing row per inner box,
--    which would result in $45 + N × (inner-box rate) per cycle
--    instead of the correct $45.
--
--    Null out next_billing_date for every non-PALLET-tier row whose
--    owning PSN is PALLET-mode. The PALLET-tier row(s) on the same
--    PSN keep their date and continue to bill the $45/mo as intended.
UPDATE "storage_boxes" sb
SET "next_billing_date" = NULL,
    "updated_at"        = now()
FROM "psns" p
WHERE p."id"             = sb."psn_id"
  AND p."shipping_mode"  = 'PALLET'
  AND sb."tier"         <> 'PALLET'
  AND sb."next_billing_date" IS NOT NULL;
