-- Migration 0021 — Phase 2 shopper admin redesign.
--
-- Adds a new ShopperRequestStatus value `AWAITING_DELIVERY` that sits
-- between PROCURING and READY_TO_SHIP. When admin marks every line as
-- PURCHASED or UNAVAILABLE (i.e. the items are bought and we're waiting
-- for them to arrive at our warehouse), the request auto-transitions to
-- AWAITING_DELIVERY. From there, admin sets the shipping details and
-- transitions to READY_TO_SHIP once the items physically arrive.
--
-- The retired AWAITING_RECONCILIATION + followup-payment flow stays in
-- the enum for existing in-flight requests; new requests skip it. The
-- backing columns (itemsActualSubtotalCents, followupAmountCents, etc.)
-- also remain in place — no destructive change. We can clean them up in
-- a later migration once no historical requests reference them.
--
-- Forward-only.

ALTER TYPE "ShopperRequestStatus"
  ADD VALUE IF NOT EXISTS 'AWAITING_DELIVERY';
