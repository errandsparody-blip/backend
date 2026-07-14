-- Migration 0040 — Shipping Points foundation (Phase A of the fulfillment
-- workflow v2 redesign).
--
-- Purely additive. NO existing behaviour changes with this migration alone —
-- the vendor order flow, admin pack workflow, wallet debit rules, and status
-- machine all stay exactly as they were.
--
-- What lands here:
--
--   1. `products.shipping_points` (DECIMAL(10,4), nullable)
--        Per-product shipping-cost proxy. Super-admin assigns a numeric
--        value at inventory receive time; the vendor never sees it. The
--        sum across an order's lines is mapped through the config row
--        `shipping_point_estimate_ranges` to produce a non-billable
--        estimate range shown to the vendor at submit (Phase B).
--        DECIMAL not FLOAT because these values are compared for
--        bucket membership — FP drift would put a product on the
--        wrong side of a range boundary.
--
--   2. `orders.workflow_version` (INT NOT NULL DEFAULT 1)
--        Discriminator between the legacy fulfillment workflow (1) and
--        the new pack-first workflow (2). Every existing row backfills
--        to 1 so nothing in flight changes behaviour. New orders
--        created after Phase B ships get 2 and enter the new status
--        machine. Every transition service inspects this column and
--        dispatches to the correct handler. Never mutable — once an
--        order is created under a workflow, it lives its whole life
--        there.
--
--   3. Config row `shipping_point_estimate_ranges`
--        Seeded from the "Shipping Point Range Table" in the client's
--        spec (page 11 of the v2 doc). Structure:
--          { buckets: [ { pointsMin, pointsMax, dollarsMin, dollarsMax } ] }
--        Bucket boundaries are half-open on the right (pointsMin <=
--        sum < pointsMax) EXCEPT the last, which is inclusive so the
--        top of the highest bucket doesn't fall through. Buckets are
--        stored in insertion order; the resolver walks them low → high
--        and returns the first match.
--
-- Rollback: dropping shipping_points is safe (no FK, no read from
-- existing code). Dropping workflow_version means orders lose their
-- "which flow" discriminator, so once Phase B ships this column must
-- stay. Config row can be deleted; the loader falls back to the
-- compiled-in seed.

ALTER TABLE "products"
  ADD COLUMN "shipping_points" DECIMAL(10, 4);

-- Partial index — cheap query for "products missing shipping points"
-- which the admin PSN receive page needs to surface for the super
-- admin. Filtered so it stays tiny; once every product has points,
-- the index has zero entries.
CREATE INDEX "products_missing_shipping_points_idx"
  ON "products" ("vendor_id")
  WHERE "shipping_points" IS NULL;

ALTER TABLE "orders"
  ADD COLUMN "workflow_version" INTEGER NOT NULL DEFAULT 1;

-- Seed the range table config row. IF NOT EXISTS via ON CONFLICT so
-- re-running the migration on a database that already has the row
-- (e.g., a manual seed in staging) doesn't clobber it.
INSERT INTO "configuration" ("key", "value", "description", "updated_at")
VALUES (
  'shipping_point_estimate_ranges',
  '{"buckets":[
    {"pointsMin":0,   "pointsMax":0.5, "dollarsMin":500,  "dollarsMax":800},
    {"pointsMin":0.5, "pointsMax":1.5, "dollarsMin":800,  "dollarsMax":1200},
    {"pointsMin":1.5, "pointsMax":3,   "dollarsMin":1200, "dollarsMax":1800},
    {"pointsMin":3,   "pointsMax":5,   "dollarsMin":1800, "dollarsMax":2500}
  ]}'::jsonb,
  'Fulfillment v2 — maps a summed shipping-point value to an estimated dollar range shown to the vendor at order submit. Editable by super admin. Dollars are stored in cents. See migration 0040.',
  NOW()
)
ON CONFLICT ("key") DO NOTHING;
