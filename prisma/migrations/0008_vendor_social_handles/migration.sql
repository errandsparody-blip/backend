-- =============================================================================
-- 0008_vendor_social_handles
--
-- Adds social-handle and verification metadata to vendors so the admin KYC
-- review can check the vendor's public web presence (Instagram, TikTok, X,
-- corporate website). Reviewing a real footprint on these platforms catches
-- a meaningful share of fraudulent signups before any inventory moves.
--
-- All columns are nullable — existing vendors keep working without backfill,
-- and onboarding never blocks because of an empty social field. The admin
-- decides whether the visible profile is sufficient.
-- =============================================================================

ALTER TABLE "vendors"
  ADD COLUMN "instagram_handle"   TEXT,
  ADD COLUMN "tiktok_handle"      TEXT,
  ADD COLUMN "x_handle"           TEXT,
  ADD COLUMN "website_url"        TEXT,
  ADD COLUMN "social_verified_at" TIMESTAMP(3),
  ADD COLUMN "social_verified_by" UUID,
  ADD COLUMN "kyc_rejected_at"    TIMESTAMP(3),
  ADD COLUMN "kyc_rejection_reason" TEXT,
  ADD COLUMN "kyc_decided_by"     UUID;

-- Format guards. Handles are lowercased + trimmed in the service, but the DB
-- enforces a tight character class so we never end up with a row whose value
-- couldn't possibly map to a real Instagram / TikTok / X account.
ALTER TABLE "vendors"
  ADD CONSTRAINT "vendors_instagram_handle_format"
    CHECK ("instagram_handle" IS NULL OR "instagram_handle" ~ '^[a-z0-9._]{1,30}$'),
  ADD CONSTRAINT "vendors_tiktok_handle_format"
    CHECK ("tiktok_handle"    IS NULL OR "tiktok_handle"    ~ '^[a-z0-9._]{1,24}$'),
  ADD CONSTRAINT "vendors_x_handle_format"
    CHECK ("x_handle"         IS NULL OR "x_handle"         ~ '^[a-z0-9_]{1,15}$'),
  ADD CONSTRAINT "vendors_website_url_format"
    CHECK ("website_url"      IS NULL OR "website_url"      ~ '^https?://[^\s/$.?#].[^\s]*$');

-- Index pending-KYC rows to keep the admin review queue fast as vendor count
-- grows. We hit this list every time the queue page loads.
CREATE INDEX IF NOT EXISTS "vendors_kyc_review_queue_idx"
  ON "vendors" ("created_at" ASC)
  WHERE "kyc_status" IN ('PENDING', 'IN_PROGRESS', 'REQUIRES_RESUBMISSION');
