-- =============================================================================
-- 0016 — Personal Shopper actual weight + packed-parcel dimensions.
--
-- The shopper flow is different from the vendor 3PL flow: in 3PL we know
-- the weight of every product upfront (vendors declare it on the Product
-- row). For shopper requests we're buying random items from random
-- retailers, so weight is unknown until the items physically arrive at
-- our warehouse and the warehouse team puts them on a scale.
--
-- Two new sets of fields:
--
--   1. Per-line actual weight — captured when the item arrives. Used to
--      compute total parcel weight and (eventually) feed an EasyPost rate
--      quote. Optional because the warehouse may not weigh every line
--      individually (small accessories that are weighed as part of a kit).
--
--   2. Parcel dimensions — the packed box that's actually going to the
--      buyer. Captured at pack time. Drives carrier rate accuracy more
--      than weight does for international shipments. Optional during
--      procurement; required if admin wants to use carrier auto-quote
--      (future).
--
-- All fields are nullable so old rows survive without backfill.
-- All checks are non-negative — the obvious sanity rails.
-- =============================================================================

ALTER TABLE "shopper_request_lines"
  ADD COLUMN "actual_weight_oz" REAL
    CHECK ("actual_weight_oz" IS NULL OR "actual_weight_oz" >= 0);

ALTER TABLE "shopper_requests"
  ADD COLUMN "parcel_length_in" REAL
    CHECK ("parcel_length_in" IS NULL OR "parcel_length_in" >= 0),
  ADD COLUMN "parcel_width_in"  REAL
    CHECK ("parcel_width_in"  IS NULL OR "parcel_width_in"  >= 0),
  ADD COLUMN "parcel_height_in" REAL
    CHECK ("parcel_height_in" IS NULL OR "parcel_height_in" >= 0),
  ADD COLUMN "parcel_weight_oz" REAL
    CHECK ("parcel_weight_oz" IS NULL OR "parcel_weight_oz" >= 0);
