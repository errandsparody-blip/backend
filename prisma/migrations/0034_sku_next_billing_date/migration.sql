-- Migration 0034 — per-SKU "next billing date" for the recurring storage cron.
--
-- Why:
--   Vendors who added inventory mid-month were seeing the next cron charge
--   inflate by the new inventory's full monthly rate, even though they'd
--   just paid first-month storage at PSN submit. The upcoming bill jumped
--   from $50 to $72 with "due in 7 days" copy, which felt like a double
--   charge from the vendor's perspective.
--
--   Model B (the one the user picked): the first-month storage fee paid at
--   intake INCLUDES the SKU's first cron cycle. The cron skips a SKU until
--   its `next_billing_date` has been reached, then bills + bumps the date
--   forward by one month.
--
-- Semantics:
--   At SKU creation (admin receive), `next_billing_date` is set to the
--   first day of the month AFTER the receive month — i.e., we skip the
--   immediately-next cron run because that cycle was paid at intake. From
--   then on, every cron debit bumps the date forward one month.
--
--   Example timeline (receive on May 25):
--     May 22 — PSN submitted, intake fee paid (stocking + first-month).
--     May 25 — admin receives boxes; SKU created with next_billing_date = July 1.
--     Jun  1 — cron runs; SKU has next_billing_date > today → SKIPPED.
--     Jul  1 — cron runs; SKU has next_billing_date <= today → BILLED;
--              bump next_billing_date to August 1.
--     Aug  1 — cron runs; BILLED; bump to September 1.
--
-- Backfill:
--   Every existing SKU gets `next_billing_date = first of NEXT calendar
--   month` so the next cron run continues to bill them exactly as it would
--   have before this migration. There's no retroactive credit — we just
--   change behaviour for newly received inventory going forward.
--
-- Idempotency:
--   IF NOT EXISTS on the column add + a conditional backfill UPDATE so
--   re-running the migration is a no-op on rows that already have a value.
--
-- Why DATE not TIMESTAMP:
--   The cron logic only cares about day-granularity ("is today >= the
--   stored date?"). Storing a TIMESTAMP introduces timezone questions
--   that don't add value here — the cron runs at 02:00 UTC daily, and a
--   DATE comparison is unambiguous.
--
-- No index needed yet:
--   The cron query is already vendor-scoped + status-scoped, both of
--   which have existing indexes. Adding (next_billing_date) would only
--   help if we ever scanned the table cross-vendor for "what bills
--   today?" — we don't. Re-evaluate when vendor count crosses 1k.

ALTER TABLE "skus"
  ADD COLUMN IF NOT EXISTS "next_billing_date" DATE;

-- One-time backfill: existing rows default to "next first-of-month" so
-- they keep billing on schedule. Only rows missing the value get touched.
UPDATE "skus"
SET    "next_billing_date" = (date_trunc('month', CURRENT_DATE) + INTERVAL '1 month')::date
WHERE  "next_billing_date" IS NULL;

-- Now lock the column NOT NULL. Safe because backfill above guarantees no
-- nulls remain on a re-run.
ALTER TABLE "skus"
  ALTER COLUMN "next_billing_date" SET NOT NULL;
