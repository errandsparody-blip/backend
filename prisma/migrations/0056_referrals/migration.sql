-- Migration 0056 — referral system (event capture + vendor-to-vendor).
--
-- A vendor gets a unique referral_code they can share. Campaigns cover
-- in-person events (a code/QR at the booth). Each referred vendor has at
-- most one referral row. When a referred vendor's FIRST inbound PSN is
-- received, both the referrer and the referred vendor are credited
-- reward_cents ($50 each by default) — paid once (rewarded_at guards it).
--
-- Idempotent DDL (IF NOT EXISTS / ADD VALUE IF NOT EXISTS) so a re-run
-- after a partial deploy can't wedge `prisma migrate deploy`.

-- New ledger type for the referral bonus credit. Safe inside a tx on
-- PG12+ because we don't USE the value in this migration.
ALTER TYPE "LedgerEntryType" ADD VALUE IF NOT EXISTS 'REFERRAL_BONUS';

-- Vendor's own shareable code.
ALTER TABLE "vendors" ADD COLUMN IF NOT EXISTS "referral_code" VARCHAR(32);
CREATE UNIQUE INDEX IF NOT EXISTS "vendors_referral_code_key" ON "vendors"("referral_code");

-- Campaigns (events).
CREATE TABLE IF NOT EXISTS "referral_campaigns" (
  "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "code"        VARCHAR(40)  NOT NULL,
  "name"        VARCHAR(120) NOT NULL,
  "description" TEXT,
  "reward_cents" INTEGER     NOT NULL DEFAULT 5000,
  "active"      BOOLEAN      NOT NULL DEFAULT true,
  "created_at"  TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "referral_campaigns_code_key" ON "referral_campaigns"("code");

-- Referrals — one row per referred vendor.
CREATE TABLE IF NOT EXISTS "referrals" (
  "id"                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "referred_vendor_id"       UUID NOT NULL,
  "referrer_vendor_id"       UUID,
  "campaign_id"              UUID,
  "ref_code_used"            VARCHAR(40),
  "status"                   VARCHAR(24) NOT NULL DEFAULT 'REGISTERED',
  "reward_cents"             INTEGER NOT NULL DEFAULT 5000,
  "first_psn_received_at"    TIMESTAMPTZ,
  "rewarded_at"              TIMESTAMPTZ,
  "referrer_reward_entry_id" UUID,
  "referee_reward_entry_id"  UUID,
  "created_at"               TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "referrals_referred_vendor_fkey" FOREIGN KEY ("referred_vendor_id") REFERENCES "vendors"("id") ON DELETE CASCADE,
  CONSTRAINT "referrals_referrer_vendor_fkey" FOREIGN KEY ("referrer_vendor_id") REFERENCES "vendors"("id") ON DELETE SET NULL,
  CONSTRAINT "referrals_campaign_fkey" FOREIGN KEY ("campaign_id") REFERENCES "referral_campaigns"("id") ON DELETE SET NULL
);
-- One referral attribution per referred vendor.
CREATE UNIQUE INDEX IF NOT EXISTS "referrals_referred_vendor_id_key" ON "referrals"("referred_vendor_id");
CREATE INDEX IF NOT EXISTS "referrals_referrer_vendor_id_idx" ON "referrals"("referrer_vendor_id");
CREATE INDEX IF NOT EXISTS "referrals_campaign_id_idx" ON "referrals"("campaign_id");
CREATE INDEX IF NOT EXISTS "referrals_status_idx" ON "referrals"("status");
