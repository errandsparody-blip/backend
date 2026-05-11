-- Migration 0020 — Phase 2 admin receiving expansion.
--
-- The original PSN flow had two outcomes once a package arrived: admin
-- received it (RECEIVED / PARTIALLY_RECEIVED / DISCREPANCY) or did nothing.
-- This migration adds three new outcomes — HOLD, REJECTED, RETURN_REQUESTED —
-- plus a `psn_holds` table that tracks the extra-charge flow.
--
-- Statuses added:
--   HOLD              — package received but blocked until vendor pays an
--                       additional fee (wrong tier, repackaging, etc.).
--   REJECTED          — admin refused the package outright. No inventory,
--                       no further action; vendor's onboarding fee stands
--                       per existing policy.
--   RETURN_REQUESTED  — admin (or auto-conversion from a stale HOLD) ships
--                       the unopened package back to the vendor's return
--                       address. Vendor pays return shipping from wallet.
--
-- The `psn_holds` table records the lifecycle of each hold:
--   PENDING_PAYMENT — admin placed the hold; vendor hasn't paid yet
--   PAID            — wallet was debited; PSN auto-returned to AWAITING_RECEIPT
--   CANCELLED       — hold was manually cancelled by admin before payment
--   AUTO_RETURNED   — hold sat past `release_after` without payment, the
--                     system converted it into a RETURN_REQUESTED PSN
--
-- Forward-only. The new statuses don't break any existing reads (any code
-- switching on PsnStatus will hit its `default` branch, which is logged
-- rather than crashing).

-- ---------------------------------------------------------------------------
-- 1. New PsnStatus values.
-- ---------------------------------------------------------------------------
ALTER TYPE "PsnStatus" ADD VALUE IF NOT EXISTS 'HOLD';
ALTER TYPE "PsnStatus" ADD VALUE IF NOT EXISTS 'REJECTED';
ALTER TYPE "PsnStatus" ADD VALUE IF NOT EXISTS 'RETURN_REQUESTED';

-- ---------------------------------------------------------------------------
-- 2. PsnHoldStatus enum.
-- ---------------------------------------------------------------------------
CREATE TYPE "PsnHoldStatus" AS ENUM (
  'PENDING_PAYMENT',
  'PAID',
  'CANCELLED',
  'AUTO_RETURNED'
);

-- ---------------------------------------------------------------------------
-- 3. psn_holds table.
-- ---------------------------------------------------------------------------
CREATE TABLE "psn_holds" (
  "id"                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "psn_id"             UUID NOT NULL,
  -- The fee admin is requesting. Always positive cents (debit direction
  -- handled by wallet.debit when the vendor pays).
  "extra_charge_cents" INTEGER NOT NULL CHECK ("extra_charge_cents" >= 0),
  -- Short reason category for filtering / reporting.
  "reason_code"        TEXT NOT NULL,
  -- Free-text explanation shown to the vendor.
  "reason_note"        TEXT NOT NULL,
  "status"             "PsnHoldStatus" NOT NULL DEFAULT 'PENDING_PAYMENT',
  "created_by"         UUID,
  "created_at"         TIMESTAMP NOT NULL DEFAULT now(),
  -- When the wallet was successfully debited (PAID path).
  "paid_at"            TIMESTAMP,
  -- Auto-conversion deadline: if status is still PENDING_PAYMENT past this
  -- time, a background job flips the PSN to RETURN_REQUESTED + this hold to
  -- AUTO_RETURNED. Default: 7 days after creation (set in app code).
  "release_after"      TIMESTAMP NOT NULL,
  -- Ledger entry id of the debit (populated when PAID).
  "ledger_entry_id"    UUID,

  CONSTRAINT "psn_holds_psn_id_fkey"
    FOREIGN KEY ("psn_id") REFERENCES "psns"("id") ON DELETE CASCADE,
  CONSTRAINT "psn_holds_ledger_entry_id_fkey"
    FOREIGN KEY ("ledger_entry_id") REFERENCES "ledger_entries"("id")
    ON DELETE SET NULL
);

-- Index: PSN → hold lookups (the receive page renders the active hold).
CREATE INDEX "psn_holds_psn_id_status_idx" ON "psn_holds" ("psn_id", "status");
-- Index: the auto-return cron scans PENDING_PAYMENT past release_after.
CREATE INDEX "psn_holds_status_release_after_idx"
  ON "psn_holds" ("status", "release_after");

-- ---------------------------------------------------------------------------
-- 4. Reject / return reason columns on PSN itself.
-- These are denormalised onto the PSN row (not a separate table) because
-- a PSN can only be rejected/returned once — there's no history to keep.
-- ---------------------------------------------------------------------------
ALTER TABLE "psns"
  ADD COLUMN "rejected_reason"        TEXT,
  ADD COLUMN "rejected_at"            TIMESTAMP,
  ADD COLUMN "return_requested_reason" TEXT,
  ADD COLUMN "return_requested_at"    TIMESTAMP,
  -- The return-shipping wallet debit (when known). Mirrors the pattern
  -- used on the Order row for the outbound carrier debit.
  ADD COLUMN "return_shipping_cents"  INTEGER;
