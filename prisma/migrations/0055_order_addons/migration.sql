-- Migration 0055 — vendor-selected label add-ons.
--
-- Vendors opt into optional carrier services when they submit an order
-- request; the admin honours whatever the vendor chose at buy-label time.
--   * insurance_requested        — buy carrier insurance for the shipment.
--                                  The insured amount is the order's already
--                                  known items_declared_value_cents, so the
--                                  vendor doesn't re-key a value.
--   * signature_required         — signature confirmation on delivery.
--   * adult_signature_required   — adult (21+) signature on delivery.
--
-- All default false so every existing order and any older API client keeps
-- working unchanged (no add-ons = today's behaviour).
ALTER TABLE "orders"
  ADD COLUMN "insurance_requested" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "signature_required" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "adult_signature_required" BOOLEAN NOT NULL DEFAULT false;
