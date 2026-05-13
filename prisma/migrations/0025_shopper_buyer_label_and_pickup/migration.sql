-- Migration 0025 — buyer-label upload + pickup details for the shopper
-- shipping flow. Depends on migration 0025a which committed the new enum
-- values (BUYER_FREIGHT, READY_FOR_PICKUP) ahead of these columns being
-- referenced anywhere.
--
-- All four columns are NULLABLE — historical rows from before this
-- migration ran (PLATFORM_FREIGHT / BUYER_FORWARDER) don't have a buyer
-- label or pickup window and never will. Pickup completion is captured
-- on the row itself rather than via the inherited shipped_at, so the
-- buyer-facing receipt can clearly differentiate "shipped" from "picked
-- up" without overloading one timestamp.

ALTER TABLE "shopper_requests"
  ADD COLUMN IF NOT EXISTS "buyer_label_url"       TEXT,
  ADD COLUMN IF NOT EXISTS "pickup_name"           TEXT,
  ADD COLUMN IF NOT EXISTS "pickup_scheduled_at"   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "pickup_completed_at"   TIMESTAMPTZ;
