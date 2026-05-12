-- Migration 0018b — extend LedgerEntryType enum.
--
-- WHY THIS LIVES IN ITS OWN FILE.
-- ------------------------------
-- Postgres rejects "use" of a new enum value in the same transaction that
-- added the value (SQLSTATE 55P04 — "unsafe use of new value"). Prisma
-- wraps every migration file in a single transaction, so we cannot ALTER
-- TYPE + INSERT-referencing-the-new-value in the same migration.
--
-- The original 0019_unified_ledger.sql did exactly that — added the new
-- enum values at the top and then back-filled rows that referenced them
-- in the same file. The first prod deploy failed:
--
--   ERROR: unsafe use of new value "PARTNERSHIP_ITEM_COST" of enum type
--   "LedgerEntryType"
--   HINT: New enum values must be committed before they can be used.
--
-- This file commits the new enum values in their own transaction. The
-- next migration (0019_unified_ledger) then handles the schema changes
-- and back-fill — by the time it runs, the new enum values are
-- guaranteed to be committed and usable.
--
-- Why the `0018b` prefix? Lexicographic ordering puts it after
-- `0018_psn_holds_and_actions` and before `0019_unified_ledger`, which
-- is exactly the slot it needs to occupy in Prisma's migration history.
--
-- Forward-only. IF NOT EXISTS makes each statement idempotent so re-runs
-- in a half-applied state are safe.

ALTER TYPE "LedgerEntryType" ADD VALUE IF NOT EXISTS 'RECEIVING_HOLD_FEE';
ALTER TYPE "LedgerEntryType" ADD VALUE IF NOT EXISTS 'PARTNERSHIP_ITEM_COST';
ALTER TYPE "LedgerEntryType" ADD VALUE IF NOT EXISTS 'PURCHASE_FEE';
ALTER TYPE "LedgerEntryType" ADD VALUE IF NOT EXISTS 'REFUND';
