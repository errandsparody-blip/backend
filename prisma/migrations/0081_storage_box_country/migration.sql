-- 0081_storage_box_country
--
-- USA + Canada (Phase 4). Tags each physical storage box with its country
-- (US / CA), inherited from its PSN, so the daily storage-billing cron can bill
-- each country separately at that country's rate. Everything existing is USA;
-- the NOT NULL DEFAULT backfills every row in place. Additive and non-breaking.

ALTER TABLE "storage_boxes" ADD COLUMN "country" CHAR(2) NOT NULL DEFAULT 'US';

CREATE INDEX "storage_boxes_vendor_id_country_status_idx"
  ON "storage_boxes" ("vendor_id", "country", "status");
