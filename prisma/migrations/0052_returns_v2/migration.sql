-- Migration 0052 — Returns v2 (policy alignment).
--
-- Aligns the returns module with the written return policy:
--
--   * Vendor supplies the inbound return TRACKING and an EXPECTED
--     DELIVERY DATE at creation (the customer pays return shipping —
--     USA Errands does not buy an inbound label). New columns:
--     returns.expected_delivery_date; inbound_carrier / inbound_tracking
--     already exist (previously populated by the removed auto-buy path).
--
--   * On receipt USA Errands takes & shares photos of the received
--     items → returns.received_photo_urls.
--
--   * Disposition is decided by the VENDOR (restock / dispose / donate).
--     ReturnLine already had restocked_qty / disposed_qty; this adds
--     donated_qty. Two new ReturnStatus values model the flow:
--       INSTRUCTED — vendor has given handling instructions
--       DONATED    — a terminal disposition alongside RESTOCKED/DISPOSED
--
--   * A flat processing fee (policy: $2.50) is CHARGED to the vendor per
--     return at finalize — there is NO product refund. Stored on the
--     return (processing_fee_cents) plus any handling cost
--     (handling_cost_cents). New config row returns_processing_fee_cents
--     (default 250) lets ops tune it without a deploy.
--
--   * There is NO platform-enforced return time window — the age limit
--     is the vendor's own policy. (The returns_window_days row from
--     migration 0018 is left in place but no longer read.)
--
-- Additive only: column adds, enum-value adds, one config insert. No
-- drops, no data mutation. Enum ADD VALUE statements come first (same
-- pattern as migration 0041) so a Postgres that wraps the file in a
-- transaction still applies cleanly (the new values are not USED in
-- this migration).

ALTER TYPE "ReturnStatus" ADD VALUE IF NOT EXISTS 'INSTRUCTED';
ALTER TYPE "ReturnStatus" ADD VALUE IF NOT EXISTS 'DONATED';

ALTER TABLE "returns"
  ADD COLUMN "expected_delivery_date" DATE,
  ADD COLUMN "processing_fee_cents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "handling_cost_cents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "received_photo_urls" TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE "returns"
  ADD CONSTRAINT "returns_processing_fee_nonneg" CHECK ("processing_fee_cents" >= 0),
  ADD CONSTRAINT "returns_handling_cost_nonneg" CHECK ("handling_cost_cents" >= 0);

ALTER TABLE "return_lines"
  ADD COLUMN "donated_qty" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "return_lines"
  ADD CONSTRAINT "return_lines_donated_qty_nonneg" CHECK ("donated_qty" >= 0);

INSERT INTO "configuration" ("key", "value", "description", "updated_at")
  VALUES (
    'returns_processing_fee_cents',
    '250'::jsonb,
    'Return processing fee in cents, charged to the vendor wallet when a return is finalized (policy: $2.50 per return). No product refund is issued.',
    NOW()
  )
  ON CONFLICT ("key") DO NOTHING;
