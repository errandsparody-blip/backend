-- Migration 0023a — wire-transfer / ID-verification status values.
--
-- Adds the new ShopperRequestStatus values used by the high-value
-- (> $1,000) wire-transfer track. Split from the column-additions
-- migration (0023) because Postgres refuses to USE a newly-added enum
-- value within the same transaction that added it (error 55P04
-- "unsafe use of new value"). 0023 doesn't actually reference any of
-- these values in DEFAULTs or INSERTs, but keeping additions in their
-- own migration is the same safe pattern we adopted after the 0019
-- ledger incident — and it lets a future SQL change INSIDE 0024+
-- reference the values without surprises.
--
-- The full lifecycle these unlock (high-value buyer):
--
--   AWAITING_ID_VERIFICATION  ← created with payment_method = WIRE
--        ↓ (buyer uploads ID + selfie)
--   ID_UNDER_REVIEW
--        ↓ (admin approves)
--   QUOTE_SENT                ← bank-transfer instructions revealed
--        ↓ (buyer wires + uploads proof)
--   AWAITING_WIRE_PAYMENT
--   WIRE_PROOF_UPLOADED
--   WIRE_UNDER_REVIEW
--        ↓ (admin confirms payment)
--   WIRE_CONFIRMED
--        ↓
--   PURCHASE_APPROVED         ← rejoins the existing PROCURING rail
--
-- Forward-only. No backfill — every value defaults to NULL/NONE on
-- the existing column extensions in migration 0023.

ALTER TYPE "ShopperRequestStatus" ADD VALUE IF NOT EXISTS 'AWAITING_ID_VERIFICATION';
ALTER TYPE "ShopperRequestStatus" ADD VALUE IF NOT EXISTS 'ID_UNDER_REVIEW';
ALTER TYPE "ShopperRequestStatus" ADD VALUE IF NOT EXISTS 'QUOTE_SENT';
ALTER TYPE "ShopperRequestStatus" ADD VALUE IF NOT EXISTS 'AWAITING_WIRE_PAYMENT';
ALTER TYPE "ShopperRequestStatus" ADD VALUE IF NOT EXISTS 'WIRE_PROOF_UPLOADED';
ALTER TYPE "ShopperRequestStatus" ADD VALUE IF NOT EXISTS 'WIRE_UNDER_REVIEW';
ALTER TYPE "ShopperRequestStatus" ADD VALUE IF NOT EXISTS 'WIRE_CONFIRMED';
ALTER TYPE "ShopperRequestStatus" ADD VALUE IF NOT EXISTS 'PURCHASE_APPROVED';
