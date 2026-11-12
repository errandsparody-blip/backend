-- 0080_vendor_flat_fee
--
-- USA + Canada (Phase 5). Per-vendor negotiated flat-rate fulfillment pricing.
-- One config per vendor, covering both countries. All vendors default to OFF,
-- so everyone stays on the existing fee schedule until a SUPER_ADMIN turns a
-- vendor's flat fee on. Additive; existing rows default in place.

ALTER TABLE "vendors" ADD COLUMN "flat_fee_enabled"   BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "vendors" ADD COLUMN "flat_fee_cents"     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "vendors" ADD COLUMN "flat_fee_max_units" INTEGER NOT NULL DEFAULT 0;
