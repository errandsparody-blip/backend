-- =============================================================================
-- 0012 — Persist Stripe refund ids for shopper cancellations.
--
-- Why: today, the cancel-with-refund admin action issues a Stripe refund and
-- discards the refund id. That breaks two things:
--
--   1. Forensics — when the buyer disputes the refund, support can't link
--      our shopper_requests row to the Stripe refund without manually
--      grepping the audit log timestamps.
--
--   2. Multi-intent refunds — if the buyer paid both the intake and a
--      positive follow-up, cancel-with-refund needs to refund BOTH intents.
--      That requires storing two refund ids, not one.
--
-- We add two nullable columns:
--
--   cancel_intake_refund_id    — refund issued against the intake intent at
--                                cancel time. Null when intake wasn't paid.
--
--   cancel_followup_refund_id  — refund issued against the followup intent
--                                at cancel time. Null when buyer never paid
--                                a positive followup, or the followup intent
--                                doesn't exist (negative-followup case).
--
-- Note: `followup_stripe_refund_id` (existing) keeps its meaning — the refund
-- issued because actuals came in UNDER estimate (negative-followup branch).
-- Cancellations use the two new columns to avoid overwriting that value.
-- =============================================================================

ALTER TABLE "shopper_requests"
  ADD COLUMN "cancel_intake_refund_id"    TEXT,
  ADD COLUMN "cancel_followup_refund_id"  TEXT;
