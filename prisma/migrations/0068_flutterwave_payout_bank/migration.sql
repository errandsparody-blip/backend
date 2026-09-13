-- Migration 0068 — store the vendor's Flutterwave bank details on their payout
-- account, so unified collect-then-payout can transfer their share via the
-- Flutterwave Transfers API (a subaccount only receives split settlements at
-- charge time; a transfer targets a bank account). NULL for Stripe accounts.
-- Additive + idempotent.

ALTER TABLE "vendor_payout_accounts"
  ADD COLUMN IF NOT EXISTS "bank_code" TEXT,
  ADD COLUMN IF NOT EXISTS "account_number" TEXT;
