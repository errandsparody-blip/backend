-- Migration 0061 — buyer self-service return requests for storefront orders
-- (Migration 0059 follow-up). A buyer asks to return a shipped/delivered order;
-- an admin approves (which triggers a refund) or rejects. Additive + idempotent.

CREATE TABLE IF NOT EXISTS "storefront_return_requests" (
  "id"                   UUID         NOT NULL DEFAULT gen_random_uuid(),
  "reference"            TEXT         NOT NULL,
  "storefront_order_id"  UUID         NOT NULL,
  "buyer_email"          TEXT         NOT NULL,
  "status"               TEXT         NOT NULL DEFAULT 'REQUESTED',
  -- REQUESTED | APPROVED | REJECTED
  "reason"               TEXT         NOT NULL,
  "resolution_note"      TEXT,
  "refund_id"            TEXT,
  "refunded_cents"       INTEGER,
  "resolved_by"          UUID,
  "resolved_at"          TIMESTAMP(3),
  "created_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "storefront_return_requests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "storefront_return_requests_order_fkey"
    FOREIGN KEY ("storefront_order_id") REFERENCES "storefront_orders" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "storefront_return_requests_reference_key"
  ON "storefront_return_requests" ("reference");
CREATE INDEX IF NOT EXISTS "storefront_return_requests_status_created_idx"
  ON "storefront_return_requests" ("status", "created_at");
CREATE INDEX IF NOT EXISTS "storefront_return_requests_order_idx"
  ON "storefront_return_requests" ("storefront_order_id");
-- At most one OPEN (REQUESTED) return per order.
CREATE UNIQUE INDEX IF NOT EXISTS "storefront_return_requests_one_open_idx"
  ON "storefront_return_requests" ("storefront_order_id") WHERE "status" = 'REQUESTED';

CREATE SEQUENCE IF NOT EXISTS "storefront_return_ref_seq" START 1;
