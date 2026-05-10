-- =============================================================================
-- 0013 — Personal Shopper estimated U.S. sales tax.
--
-- Why: today, intake_total_cents = items_subtotal + commission. When we
-- actually procure the items in a U.S. store, the store collects sales
-- tax (typically 5–10%) on top of the items price. That tax was being
-- silently caught in the followup-reconciliation as part of "items came
-- in higher than estimate" — confusing for buyers and bad sticker shock.
--
-- This migration:
--
--   1. Snapshots the tax rate onto the request at intake (same pattern as
--      `commission_rate_bps`) so historical audits stay accurate when
--      the global rate changes.
--
--   2. Stores the estimated tax computed at intake + the actual tax the
--      admin captures during procurement. Both are displayed and
--      reconciled separately from the items subtotal.
--
--   3. Seeds `shopper_estimated_tax_bps` at 800 (8 %) — a safe
--      middle-of-the-road U.S. average. Operators can tune via
--      /admin/config/policy or the JSON editor.
--
-- The new intake formula becomes:
--   intake_total = items_subtotal + commission + estimated_tax
--
-- The new follow-up formula becomes:
--   followup_amount = (items_actual + actual_tax + shipping)
--                   - (items_subtotal + estimated_tax)
--
-- Commission is still computed on items_subtotal only — we don't earn a
-- margin on the sales tax.
-- =============================================================================

ALTER TABLE "shopper_requests"
  ADD COLUMN "estimated_tax_rate_bps" INTEGER NOT NULL DEFAULT 0
    CHECK ("estimated_tax_rate_bps" >= 0 AND "estimated_tax_rate_bps" <= 10000),
  ADD COLUMN "estimated_tax_cents"    INTEGER NOT NULL DEFAULT 0
    CHECK ("estimated_tax_cents" >= 0),
  ADD COLUMN "actual_tax_cents"       INTEGER
    CHECK ("actual_tax_cents" IS NULL OR "actual_tax_cents" >= 0);

-- Drop the defaults — new rows must compute these explicitly. The
-- defaults above were only there to satisfy the NOT NULL constraint on
-- existing rows during the migration.
ALTER TABLE "shopper_requests"
  ALTER COLUMN "estimated_tax_rate_bps" DROP DEFAULT,
  ALTER COLUMN "estimated_tax_cents"    DROP DEFAULT;

INSERT INTO "configuration" ("key", "description", "value", "updated_at")
VALUES (
  'shopper_estimated_tax_bps',
  'Personal shopper service: estimated U.S. sales tax rate as basis points of items_subtotal, charged at intake. 800 = 8%. Reconciled against actual tax paid by admin during procurement.',
  '800'::jsonb,
  now()
)
ON CONFLICT ("key") DO NOTHING;
