-- Migration 0027 — shipping-invoice payment cycle for the shopper flow.
--
-- Background: until now `setShipping` finalised the freight cost and posted
-- a receipt to the buyer, but there was no payment step before items
-- physically moved out of the warehouse. The product team decided the
-- buyer must explicitly pay the shipping line before admin can mark
-- warehouse delivery / ship / release / mark-picked-up. This migration
-- adds the columns that gate the new step.
--
-- Stripe Checkout is the universal rail for the shipping invoice — even
-- wire-track requests (≥$1k intake) use Stripe for the shipping line
-- because the amount is small and Stripe gives us a webhook-driven
-- auto-confirmation. The session/intent IDs are recorded so the webhook
-- can locate the right request.
--
-- All columns are NULLABLE — historical requests created before this
-- migration are presumed paid (the gate check skips them when
-- `shipping_cost_cents` is 0 or NULL). BUYER_FREIGHT and PICKUP
-- methods always have shipping_cost_cents = 0 so they're never gated
-- by this flow.

ALTER TABLE "shopper_requests"
  ADD COLUMN IF NOT EXISTS "shipping_invoice_session_id" TEXT,
  ADD COLUMN IF NOT EXISTS "shipping_invoice_intent_id"  TEXT,
  ADD COLUMN IF NOT EXISTS "shipping_invoice_url"        TEXT,
  ADD COLUMN IF NOT EXISTS "shipping_paid_at"            TIMESTAMPTZ;

-- Lookup: webhook receives a Stripe session id and needs to find the
-- request fast. Partial index excludes nulls so we don't bloat the index
-- with rows that don't have a session yet.
CREATE INDEX IF NOT EXISTS "shopper_requests_shipping_invoice_session_idx"
  ON "shopper_requests" ("shipping_invoice_session_id")
  WHERE "shipping_invoice_session_id" IS NOT NULL;
