-- =============================================================================
-- 0014 — Personal Shopper state-keyed sales-tax rates.
--
-- Replaces the single `shopper_estimated_tax_bps` config row introduced in
-- 0013 with a proper state-by-state lookup. U.S. sales tax is determined
-- by where the package ships TO (post-Wayfair, 2018) — for our flow that
-- means whichever U.S. address the retailer is shipping to:
--
--   PLATFORM_FREIGHT  → our warehouse state (today: TX)
--   BUYER_FORWARDER   → the buyer's forwarder address state, when supplied
--   PICKUP            → our warehouse state
--
-- Two new config rows:
--
--   shopper_tax_rates           JSON map of state ISO → bps. Operator tunes
--                               for accuracy. Seeded with reasonable
--                               combined-rate averages for all 50 states + DC.
--
--   shopper_warehouse_state     The state we ship to by default
--                               (PLATFORM_FREIGHT). Today: TX.
--
-- One new column:
--
--   effective_tax_state         Snapshot on each request of WHICH state's
--                               rate was used at intake. Audit-friendly so
--                               support can defend the math after the fact.
-- =============================================================================

-- 1. New column on shopper_requests for the snapshot.
ALTER TABLE "shopper_requests"
  ADD COLUMN "effective_tax_state" TEXT;

CREATE INDEX "shopper_requests_effective_tax_state_idx"
  ON "shopper_requests" ("effective_tax_state");

-- 2. Backfill: any existing rows used the flat 8% from 0013, so tag them
-- as "TX" for parity with what the operator likely intended. Harmless if
-- there are no rows yet (typical for a fresh deploy).
UPDATE "shopper_requests"
SET "effective_tax_state" = 'TX'
WHERE "effective_tax_state" IS NULL;

-- 3. Drop the single-rate config row from 0013 — it's superseded.
DELETE FROM "configuration"
WHERE "key" = 'shopper_estimated_tax_bps';

-- 4. Seed the warehouse-state config. Operator tunes via /admin/config.
INSERT INTO "configuration" ("key", "description", "value", "updated_at")
VALUES (
  'shopper_warehouse_state',
  'Personal shopper service: 2-letter ISO state code of the warehouse we ship to by default (PLATFORM_FREIGHT method). Used to pick the row from shopper_tax_rates.',
  '"TX"'::jsonb,
  now()
)
ON CONFLICT ("key") DO NOTHING;

-- 5. Seed the state-keyed rate map. Numbers are reasonable
-- *combined-average* rates (state + typical local) sourced from public
-- 2025 references. Operator tunes any value via /admin/config/[key].
-- Five no-sales-tax states are 0; everything else is a representative
-- combined average rounded to whole bps.
INSERT INTO "configuration" ("key", "description", "value", "updated_at")
VALUES (
  'shopper_tax_rates',
  'Personal shopper service: map of 2-letter state ISO → estimated combined sales-tax basis points. Used at intake to estimate U.S. sales tax for the buyer''s pre-payment. Tune for accuracy as needed; reconciled against actual_tax_cents during procurement.',
  '{
    "AL": 922,
    "AK": 0,
    "AZ": 838,
    "AR": 947,
    "CA": 882,
    "CO": 778,
    "CT": 635,
    "DE": 0,
    "DC": 600,
    "FL": 700,
    "GA": 738,
    "HI": 444,
    "ID": 603,
    "IL": 882,
    "IN": 700,
    "IA": 694,
    "KS": 870,
    "KY": 600,
    "LA": 956,
    "ME": 550,
    "MD": 600,
    "MA": 625,
    "MI": 600,
    "MN": 754,
    "MS": 707,
    "MO": 825,
    "MT": 0,
    "NE": 695,
    "NV": 823,
    "NH": 0,
    "NJ": 663,
    "NM": 769,
    "NY": 853,
    "NC": 698,
    "ND": 695,
    "OH": 723,
    "OK": 899,
    "OR": 0,
    "PA": 634,
    "RI": 700,
    "SC": 743,
    "SD": 644,
    "TN": 955,
    "TX": 825,
    "UT": 720,
    "VT": 624,
    "VA": 577,
    "WA": 938,
    "WV": 656,
    "WI": 543,
    "WY": 522
  }'::jsonb,
  now()
)
ON CONFLICT ("key") DO NOTHING;
