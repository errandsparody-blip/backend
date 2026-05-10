-- =============================================================================
-- 0017 — Personal Shopper freight rate snapshot + calculated cost.
--
-- Until this migration, admin entered an opaque "Shipping cost (cents)" by
-- hand. That worked but hid the math: buyers had no way to see why $14.50
-- was charged for a 24-oz package. This migration switches the workflow to:
--
--   1. Admin picks a shippingMethod (PLATFORM_FREIGHT / BUYER_FORWARDER /
--      PICKUP). Each method has a configurable per-lb rate held in the
--      `configuration` table under key `shopper_freight_rates` (matching
--      the existing `shopper_commission_bps` / `shopper_tax_rates` naming).
--
--   2. System computes shipping cost from total parcel weight × method's
--      rate per lb. The result lands in `shipping_calculated_cents`.
--
--   3. Admin can still override via `shipping_cost_cents` (real-world
--      surcharges, partner pricing, etc.). The receipt shows both numbers
--      side-by-side when they differ so the buyer sees exactly what
--      adjustment was made.
--
-- Both columns are nullable — existing rows that pre-date this migration
-- only have shipping_cost_cents (the freely-typed value), and new rows
-- with PICKUP shipping legitimately have rate=0 / calc=0 / charged=0.
--
-- Sanity rails: rate non-negative, calc non-negative. We deliberately do
-- NOT enforce that calc == cost — the override is the whole point.
-- =============================================================================

ALTER TABLE "shopper_requests"
  ADD COLUMN "freight_rate_cents_per_lb" INT
    CHECK ("freight_rate_cents_per_lb" IS NULL OR "freight_rate_cents_per_lb" >= 0),
  ADD COLUMN "shipping_calculated_cents" INT
    CHECK ("shipping_calculated_cents" IS NULL OR "shipping_calculated_cents" >= 0);

-- Seed a sensible default freight rate map so production doesn't ship
-- with PLATFORM_FREIGHT charging $0/lb on day one. Operators tune via
-- /admin/config/shopper after deploy.
--
-- Defaults reflect typical platform-managed freight costs for U.S.-to-
-- international parcels: $4.50/lb for platform freight (averaged
-- USPS/UPS); $2.00/lb for buyer-arranged forwarders (we just hand off
-- to their pickup); $0/lb for in-warehouse pickup (no shipping at all).
INSERT INTO "configuration" ("key", "value", "updated_at")
  VALUES (
    'shopper_freight_rates',
    '{"PLATFORM_FREIGHT": 450, "BUYER_FORWARDER": 200, "PICKUP": 0}'::jsonb,
    NOW()
  )
  ON CONFLICT ("key") DO NOTHING;
