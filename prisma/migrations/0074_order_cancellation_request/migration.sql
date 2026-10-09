-- Migration 0074 — vendor-initiated order cancellation requests.
--
-- Once an order is past the instant self-cancel window (DRAFT / SUBMITTED /
-- ALLOCATED) the vendor previously had no in-app way to ask for a
-- cancellation — they had to email or WhatsApp ops. These columns let a
-- vendor REQUEST a cancellation on an order that is being fulfilled but
-- hasn't shipped yet; an admin then approves (refund + restock + cancel)
-- or rejects it.
--
-- "Pending" = cancel_requested_at IS NOT NULL AND cancel_request_resolved_at IS NULL.
ALTER TABLE orders
  ADD COLUMN cancel_requested_at        TIMESTAMPTZ,
  ADD COLUMN cancel_request_reason      TEXT,
  ADD COLUMN cancel_request_note        TEXT,
  ADD COLUMN cancel_request_resolved_at TIMESTAMPTZ,
  ADD COLUMN cancel_request_outcome     TEXT;  -- 'APPROVED' | 'REJECTED'

-- Fast lookup of orders awaiting a cancellation decision (admin queue badge).
CREATE INDEX orders_cancel_request_pending_idx
  ON orders (cancel_requested_at)
  WHERE cancel_requested_at IS NOT NULL AND cancel_request_resolved_at IS NULL;
