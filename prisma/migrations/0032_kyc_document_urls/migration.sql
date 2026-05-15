-- Migration 0032 — KYC v2 document upload URLs.
--
-- Phase 2 of the expanded vendor onboarding form (see migration 0030 for the
-- structured-data Phase 1). The wizard's "Business verification" step now
-- collects four file uploads via the existing R2 presign flow:
--
--   - Government-issued ID, front
--   - Government-issued ID, back
--   - ID-holding selfie ("liveness" check)
--   - Business registration / license document
--
-- Files are uploaded directly from the browser to R2 with a presigned PUT
-- (same pattern as product images / shopper attachments / return evidence);
-- only the resulting public URL lands in Postgres. The KYC reviewer opens
-- the URL from the admin vendor detail page when working through the queue.
--
-- Compatibility / grandfathering:
--   - All four columns are NULLABLE. Existing vendors keep validating;
--     the wizard's per-step gate enforces "all four uploaded" only at
--     final-submit time, mirrored on the backend by `submitKycV2Schema`.
--   - We don't bind these columns to a CHECK constraint on URL shape —
--     the Zod layer trims + validates `z.string().url()` on every save,
--     and a future R2 host change shouldn't require a DB migration to
--     accommodate it.
--   - IF NOT EXISTS guards on every column for hand-roll idempotency
--     (matches the style of 0030 / 0031).
--
-- Indexes:
--   - None. These columns are NEVER searched across vendors. They're
--     read once per admin vendor detail page open, by primary key. A
--     btree index here would be pure overhead.

ALTER TABLE "vendors"
  ADD COLUMN IF NOT EXISTS "id_front_url"      TEXT,
  ADD COLUMN IF NOT EXISTS "id_back_url"       TEXT,
  ADD COLUMN IF NOT EXISTS "id_selfie_url"     TEXT,
  ADD COLUMN IF NOT EXISTS "business_doc_url"  TEXT;
