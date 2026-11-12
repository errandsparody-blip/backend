-- 0077_usa_canada_backbone
--
-- USA + Canada fulfillment backbone (Phase 0).
--
-- Adds a fulfillment country to stock buckets (skus) and inbound shipments
-- (psns). Everything that exists today is USA, so both columns default to 'US'
-- and the NOT NULL DEFAULT backfills every existing row in place.
--
-- Additive and non-breaking: allocation does not yet filter by country (that is
-- gated behind the country-routing config flag, which stays off until the
-- Canada rollout). This migration only puts the column — and the index that
-- country-scoped inventory reads will use — in place.

ALTER TABLE "skus" ADD COLUMN "country" CHAR(2) NOT NULL DEFAULT 'US';
ALTER TABLE "psns" ADD COLUMN "country" CHAR(2) NOT NULL DEFAULT 'US';

-- Country-scoped inventory lookups (per-country stock views, allocation).
CREATE INDEX "skus_vendor_id_country_status_idx"
  ON "skus" ("vendor_id", "country", "status");
