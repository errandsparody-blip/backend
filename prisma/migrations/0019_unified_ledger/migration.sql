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
-- NOTE: The enum extension that *used* to live at the top of this file was
-- moved into migration 0018b_ledger_enum_values. Postgres rejects "use of
-- new enum value" in the same transaction that added it (SQLSTATE 55P04),
-- and Prisma wraps each migration file in a single transaction. Splitting
-- the enum adds into their own earlier file commits them before the
-- back-fill below references them.
--
-- Schema changes (this file):
--   1. Make `vendor_id` nullable so shopper-only entries are valid.
--   2. Make `balance_after_cents` nullable for the same reason (a balance
--      only makes sense for vendor wallets; shoppers don't have one).
--   3. Add nullable `shopper_request_id` FK.
--   4. CHECK constraint: exactly one of vendor_id / shopper_request_id is
--      non-null per row.
--   5. Index for shopper-side lookups.
--   6. Backfill: write PARTNERSHIP_ITEM_COST + PURCHASE_FEE + SHIPPING
--      rows for every successfully-paid shopper request, dated to the
--      intake-paid timestamp so the chronology matches reality.
--
-- Forward-only. Rollback drops the new rows + the new column.

-- ---------------------------------------------------------------------------
-- 1 + 2. Relax NOT NULL on vendor_id and balance_after_cents.
-- ---------------------------------------------------------------------------

ALTER TABLE "ledger_entries"
  ALTER COLUMN "vendor_id" DROP NOT NULL,
  ALTER COLUMN "balance_after_cents" DROP NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. New nullable FK to shopper_requests.
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
-- 4. Exactly-one-subject CHECK.
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
-- 5. Index for shopper-side lookups (chronological per-request).
-- ---------------------------------------------------------------------------

CREATE INDEX "ledger_entries_shopper_request_id_created_at_idx"
  ON "ledger_entries" ("shopper_request_id", "created_at");

-- ---------------------------------------------------------------------------
-- 6. Rebuild the `ledger_sign_invariant` CHECK constraint.
--
-- The original constraint (migration 0005) only knew the 9 vendor-wallet
-- enum values and enforced their sign convention (DEPOSIT > 0, ONBOARDING
-- < 0, etc.). Phase 3b adds shopper-side entries whose sign convention
-- diverges from the vendor convention on the same enum values — most
-- notably SHIPPING, which is a debit (< 0) for vendors but a credit
-- (> 0) for shoppers (the buyer paying us for shipping).
--
-- The new constraint branches on which subject column is populated:
--
--   * vendor_id IS NOT NULL  → vendor wallet rules (unchanged + the new
--                              RECEIVING_HOLD_FEE debit added in Phase 2).
--   * shopper_request_id IS NOT NULL → shopper request rules:
--                              POSITIVE = revenue, NEGATIVE = costs/refunds.
--
-- Adding a check constraint validates ALL existing rows. The pre-0019
-- rows are all vendor-side and continue to satisfy the vendor branch
-- (it's a superset of the original constraint), so the validation pass
-- never has to scan anything but the existing well-typed rows.
-- ---------------------------------------------------------------------------

ALTER TABLE "ledger_entries"
  DROP CONSTRAINT IF EXISTS ledger_sign_invariant;

ALTER TABLE "ledger_entries"
  ADD CONSTRAINT ledger_sign_invariant CHECK (
    -- Vendor-side wallet entries. Sign convention: credits positive,
    -- debits negative (same as the original 0005 constraint, plus the
    -- new RECEIVING_HOLD_FEE that debits the vendor wallet when admin
    -- places a hold).
    (vendor_id IS NOT NULL AND (
      (type = 'DEPOSIT'           AND amount_cents > 0) OR
      (type = 'MANUAL_CREDIT'     AND amount_cents > 0) OR
      (type = 'ONBOARDING'        AND amount_cents < 0) OR
      (type = 'STORAGE'           AND amount_cents < 0) OR
      (type = 'FULFILLMENT'       AND amount_cents < 0) OR
      (type = 'SHIPPING'          AND amount_cents < 0) OR
      (type = 'RETURN'            AND amount_cents < 0) OR
      (type = 'MANUAL_DEBIT'      AND amount_cents < 0) OR
      (type = 'RECEIVING_HOLD_FEE' AND amount_cents < 0) OR
      -- REVERSAL can swing either way: a reversed charge becomes a
      -- credit; a reversed deposit becomes a debit. The constraint
      -- intentionally doesn't pin its sign.
      (type = 'REVERSAL')
    ))
    OR
    -- Shopper-request entries. Sign convention:
    --   POSITIVE = money flowed INTO the platform (revenue / income).
    --   NEGATIVE = money flowed OUT (refunds, supplier costs we paid).
    (shopper_request_id IS NOT NULL AND (
      (type = 'PARTNERSHIP_ITEM_COST' AND amount_cents >= 0) OR
      (type = 'PURCHASE_FEE'          AND amount_cents >= 0) OR
      (type = 'SHIPPING'              AND amount_cents >= 0) OR
      -- REFUND is the only shopper category that's strictly negative.
      -- The back-fill below doesn't write any of these; future code
      -- in ShopperLedgerService inserts them on Stripe refund events.
      (type = 'REFUND'                AND amount_cents <= 0)
    ))
  );

-- ---------------------------------------------------------------------------
-- 7. Backfill. For every shopper request that was successfully paid at
-- intake, write three ledger rows: PARTNERSHIP_ITEM_COST (items),
-- PURCHASE_FEE (our commission), and SHIPPING (if the actual shipping
-- cost is known). The enum values these rows reference were committed
-- in migration 0018b, so by the time this runs they're safe to use.
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
