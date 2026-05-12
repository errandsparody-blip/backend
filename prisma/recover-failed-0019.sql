-- One-time recovery for the failed 0019_unified_ledger migration.
-- =============================================================================
--
-- Why this file exists.
-- ---------------------
-- Migration 0019 originally combined two operations that Postgres refuses
-- to run together in one transaction:
--
--   1. ALTER TYPE "LedgerEntryType" ADD VALUE 'PARTNERSHIP_ITEM_COST' (etc.)
--   2. INSERT ... 'PARTNERSHIP_ITEM_COST' ... (the back-fill)
--
-- Postgres committed step 1 but rejected step 2 with SQLSTATE 55P04
-- ("unsafe use of new value"). Prisma marked the whole migration as
-- failed in `_prisma_migrations` and now refuses to apply any further
-- migrations until the failed row is cleared:
--
--   Error: P3009
--   migrate found failed migrations in the target database, new
--   migrations will not be applied.
--   The `0019_unified_ledger` migration started at … failed
--
-- This SQL is run by the Dockerfile CMD before `prisma migrate deploy`.
-- It clears the failed row so Prisma re-applies 0019 cleanly. The enum
-- values it needs were committed before the original failure (Postgres
-- ALTER TYPE ADD VALUE is unrollable) and are also covered by the new
-- 0018b_ledger_enum_values migration as a safety net, so the back-fill
-- will succeed on re-run.
--
-- Safe to leave in the deploy chain forever.
-- ------------------------------------------
-- Once the failed row is gone, the DELETE becomes a no-op on every
-- subsequent boot. The `finished_at IS NULL` filter only matches
-- migrations that haven't completed — successfully applied migrations
-- have a non-null `finished_at` and are untouched.

DELETE FROM "_prisma_migrations"
 WHERE migration_name = '0019_unified_ledger'
   AND finished_at IS NULL;
