-- 0063_ledger_storefront_fee_sign
--
-- Migration 0059 added the STOREFRONT_FEE ledger type (the one-time $50
-- storefront setup fee) as an enum value, but did NOT extend the
-- `ledger_sign_invariant` CHECK constraint to allow it. As a result, charging
-- the fee on Go Live inserts a vendor debit row (type = 'STOREFRONT_FEE',
-- amount_cents < 0) that matches no branch of the constraint and Postgres
-- rejects it (SQLSTATE 23514), surfacing as a 500 on POST /v1/storefront/enable.
--
-- This migration rebuilds the constraint from its last definition (migration
-- 0019) and adds the STOREFRONT_FEE branch. STOREFRONT_FEE is a vendor-side
-- debit, so it belongs in the vendor branch with amount_cents < 0. Every other
-- branch is preserved exactly, so existing rows continue to validate.

ALTER TABLE "ledger_entries"
  DROP CONSTRAINT IF EXISTS ledger_sign_invariant;

ALTER TABLE "ledger_entries"
  ADD CONSTRAINT ledger_sign_invariant CHECK (
    -- Vendor-side wallet entries. Credits positive, debits negative.
    (vendor_id IS NOT NULL AND (
      (type = 'DEPOSIT'            AND amount_cents > 0) OR
      (type = 'MANUAL_CREDIT'      AND amount_cents > 0) OR
      (type = 'ONBOARDING'         AND amount_cents < 0) OR
      (type = 'STORAGE'            AND amount_cents < 0) OR
      (type = 'FULFILLMENT'        AND amount_cents < 0) OR
      (type = 'SHIPPING'           AND amount_cents < 0) OR
      (type = 'RETURN'             AND amount_cents < 0) OR
      (type = 'MANUAL_DEBIT'       AND amount_cents < 0) OR
      (type = 'RECEIVING_HOLD_FEE' AND amount_cents < 0) OR
      -- New in 0059: one-time storefront setup fee, a vendor debit.
      (type = 'STOREFRONT_FEE'     AND amount_cents < 0) OR
      -- REVERSAL can swing either way; its sign is intentionally unpinned.
      (type = 'REVERSAL')
    ))
    OR
    -- Shopper-request entries. Positive = money into the platform;
    -- negative = money out (refunds, supplier costs).
    (shopper_request_id IS NOT NULL AND (
      (type = 'PARTNERSHIP_ITEM_COST' AND amount_cents >= 0) OR
      (type = 'PURCHASE_FEE'          AND amount_cents >= 0) OR
      (type = 'SHIPPING'              AND amount_cents >= 0) OR
      (type = 'REFUND'                AND amount_cents <= 0)
    ))
  );
