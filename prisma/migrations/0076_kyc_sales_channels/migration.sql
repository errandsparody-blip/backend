-- 0076_kyc_sales_channels
--
-- KYC v2 Section 7 — Sales channels. Adds the "do you sell on e-commerce
-- platforms?" question and its follow-ups to the vendor row. All nullable /
-- additive, so existing vendors are unaffected (they answer on next KYC edit).

ALTER TABLE "vendors" ADD COLUMN "sells_on_ecommerce" BOOLEAN;
ALTER TABLE "vendors" ADD COLUMN "ecommerce_platforms" TEXT;
ALTER TABLE "vendors" ADD COLUMN "wants_platform_integration" BOOLEAN;
