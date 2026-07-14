-- Migration 0046 — Vendor CSV bulk-import jobs.
--
-- Tracks each CSV upload a vendor pushes through the dashboard:
-- filename, total rows, success / error counts, per-row error
-- payload as JSONB. Rows are never orphaned from their vendor
-- (ON DELETE CASCADE) and never orphaned from the creator (SET
-- NULL preserves the row for finance dispute review even if the
-- user account is later deleted).
--
-- SECURITY / correctness
--   * Vendor scope is stored redundantly on the row so tenant-guard
--     queries can filter by vendor_id without a join every time.
--   * `errors` is bounded at write time (service caps at 100
--     entries — a 400-row file that fully failed serialises fine).
--   * Status is a Postgres ENUM so the queue-worker path can't
--     accidentally write a typo. Enum evolution uses ADD VALUE IF
--     NOT EXISTS in later migrations.
--   * source_filename is capped at 200 chars to prevent a
--     multi-KB path from bloating the row.
--   * All timestamps are TIMESTAMPTZ; created_at defaults to NOW()
--     and is immutable, completed_at is set once by the worker.
--   * Index (vendor_id, created_at DESC) supports the vendor
--     dashboard's "most recent first" list without a full scan.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ImportJobStatus') THEN
    CREATE TYPE "ImportJobStatus" AS ENUM ('PROCESSING', 'COMPLETED', 'FAILED');
  END IF;
END $$;

CREATE TABLE "order_import_jobs" (
  "id"               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "vendor_id"        UUID NOT NULL REFERENCES "vendors"("id") ON DELETE CASCADE,
  "status"           "ImportJobStatus" NOT NULL DEFAULT 'PROCESSING',
  "source_filename"  VARCHAR(200) NOT NULL,
  "row_count"        INTEGER NOT NULL DEFAULT 0 CHECK ("row_count" >= 0),
  "success_count"    INTEGER NOT NULL DEFAULT 0 CHECK ("success_count" >= 0),
  "error_count"      INTEGER NOT NULL DEFAULT 0 CHECK ("error_count" >= 0),
  "errors"           JSONB NOT NULL DEFAULT '[]'::jsonb,
  "created_by"       UUID REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at"       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "completed_at"     TIMESTAMPTZ,

  -- error_count + success_count must never exceed row_count (belt and
  -- braces against a bug in the worker double-counting).
  CONSTRAINT "order_import_jobs_counts_sum"
    CHECK ("success_count" + "error_count" <= "row_count")
);

CREATE INDEX "order_import_jobs_vendor_created_idx"
  ON "order_import_jobs" ("vendor_id", "created_at" DESC);

CREATE INDEX "order_import_jobs_status_idx"
  ON "order_import_jobs" ("status");

COMMIT;
