-- Migration 0019 — unify the ledger across vendor wallet + shopper requests.
--
-- The original LedgerEntry table was strictly vendor-wallet scoped (one row
-- per vendor money movement, with a running `balance_after_cents`). Shopper
-- requests, which are buyer-paid one-offs through Stripe, had no place in
-- the ledger and lived only in `shopper_requests`.
--
-- This migration unifies the two so the admin Finance page can render
-- "every dollar movement on the platform" in one filterable view.
--
-- Schema changes:
--   1. Extend `LedgerEntryType` enum with 4 new categories.
--   2. Make `vendor_id` nullable so shopper-only entries are valid.
--   3. Make `balance_after_cents` nullable for the same reason (a balance
--      only makes sense for vendor wallets; shoppers don't have one).
--   4. Add nullable `shopper_request_id` FK.
--   5. CHECK constraint: exactly one of vendor_id / shopper_request_id is
--      non-null per row.
--   6. Index for shopper-side lookups.
--   7. Backfill: write PARTNERSHIP_ITEM_COST + PURCHASE_FEE + SHIPPING
--      rows for every successfully-paid shopper request, dated to the
--      intake-paid timestamp so the chronology matches reality.
--
-- Forward-only. Rollback drops the new rows + the new column.

-- ---------------------------------------------------------------------------
-- 1. New enum values.
-- ---------------------------------------------------------------------------
-- Postgres requires ALTER TYPE ADD VALUE to run outside a transaction OR
-- be the only statement in a migration. Prisma's migration runner wraps
-- each file in a single transaction by default. We split into a separate
-- file would be the canonical fix; here we use `IF NOT EXISTS` (Postgres
-- 12+) which is transaction-safe.

ALTER TYPE "LedgerEntryType" ADD VALUE IF NOT EXISTS 'RECEIVING_HOLD_FEE';
ALTER TYPE "LedgerEntryType" ADD VALUE IF NOT EXISTS 'PARTNERSHIP_ITEM_COST';
ALTER TYPE "LedgerEntryType" ADD VALUE IF NOT EXISTS 'PURCHASE_FEE';
ALTER TYPE "LedgerEntryType" ADD VALUE IF NOT EXISTS 'REFUND';

-- ---------------------------------------------------------------------------
-- 2 + 3. Relax NOT NULL on vendor_id and balance_after_cents.
-- ---------------------------------------------------------------------------

ALTER TABLE "ledger_entries"
  ALTER COLUMN "vendor_id" DROP NOT NULL,
  ALTER COLUMN "balance_after_cents" DROP NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. New nullable FK to shopper_requests.
-- ON DELETE RESTRICT: the ledger is supposed to be immutable. Deleting a
-- shopper request that has ledger rows would corrupt the audit trail, so
-- the DB refuses outright. If we ever need to forget a shopper request
-- for legal reasons (right-to-erasure), do it via a separate redaction
-- routine that nulls PII but preserves the row.
-- ---------------------------------------------------------------------------

ALTER TABLE "ledger_entries"
  ADD COLUMN "shopper_request_id" UUID;

ALTER TABLE "ledger_entries"
  ADD CONSTRAINT "ledger_entries_shopper_request_id_fkey"
  FOREIGN KEY ("shopper_request_id") REFERENCES "shopper_requests"("id")
  ON DELETE RESTRICT
  ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 5. Exactly-one-subject CHECK.
-- Postgres treats NULL <> NULL as NULL (not FALSE), so the bitwise XOR
-- trick `(a IS NOT NULL) <> (b IS NOT NULL)` evaluates correctly here.
-- ---------------------------------------------------------------------------

ALTER TABLE "ledger_entries"
  ADD CONSTRAINT "ledger_entries_subject_chk"
  CHECK (
    (vendor_id IS NOT NULL AND shopper_request_id IS NULL)
    OR (vendor_id IS NULL AND shopper_request_id IS NOT NULL)
  );

-- ---------------------------------------------------------------------------
-- 6. Index for shopper-side lookups (chronological per-request).
-- ---------------------------------------------------------------------------

CREATE INDEX "ledger_entries_shopper_request_id_created_at_idx"
  ON "ledger_entries" ("shopper_request_id", "created_at");

-- ---------------------------------------------------------------------------
-- 7. Backfill. For every shopper request that was successfully paid at
-- intake, write three ledger rows: PARTNERSHIP_ITEM_COST (items),
-- PURCHASE_FEE (our commission), and SHIPPING (if the actual shipping
-- cost is known).
--
-- Amount sign convention for shopper rows:
--   - POSITIVE = money flowed INTO the platform (revenue / income side)
--   - NEGATIVE = money flowed OUT (refunds, supplier costs we paid)
-- This mirrors the vendor-side convention where credits are positive and
-- debits are negative.
--
-- Rows get `balance_after_cents = NULL` since shoppers have no wallet
-- balance. `description` is templated so the admin UI shows a readable
-- string without joining back to shopper_requests on every row.
-- ---------------------------------------------------------------------------

-- PARTNERSHIP_ITEM_COST — items purchased for the buyer.
-- Use itemsActualSubtotalCents when known, otherwise the estimate.
INSERT INTO "ledger_entries" (
  id, vendor_id, shopper_request_id, type, amount_cents, balance_after_cents,
  description, reference_type, reference_id, created_at
)
SELECT
  gen_random_uuid(),
  NULL,
  id,
  'PARTNERSHIP_ITEM_COST',
  COALESCE(items_actual_subtotal_cents, items_subtotal_cents),
  NULL,
  CONCAT('Items purchased for ', reference),
  'shopper_request',
  id,
  intake_paid_at
FROM "shopper_requests"
WHERE intake_paid_at IS NOT NULL;

-- PURCHASE_FEE — our markup / commission.
INSERT INTO "ledger_entries" (
  id, vendor_id, shopper_request_id, type, amount_cents, balance_after_cents,
  description, reference_type, reference_id, created_at
)
SELECT
  gen_random_uuid(),
  NULL,
  id,
  'PURCHASE_FEE',
  commission_cents,
  NULL,
  CONCAT('Purchase fee for ', reference),
  'shopper_request',
  id,
  intake_paid_at
FROM "shopper_requests"
WHERE intake_paid_at IS NOT NULL AND commission_cents > 0;

-- SHIPPING — only for requests where actual shipping has been set.
-- Date it to followup_resolved_at if that's when shipping was billed, else
-- intake_paid_at as a fallback.
INSERT INTO "ledger_entries" (
  id, vendor_id, shopper_request_id, type, amount_cents, balance_after_cents,
  description, reference_type, reference_id, created_at
)
SELECT
  gen_random_uuid(),
  NULL,
  id,
  'SHIPPING',
  shipping_cost_cents,
  NULL,
  CONCAT('Shipping for ', reference),
  'shopper_request',
  id,
  COALESCE(followup_resolved_at, intake_paid_at)
FROM "shopper_requests"
WHERE shipping_cost_cents IS NOT NULL AND shipping_cost_cents > 0;
