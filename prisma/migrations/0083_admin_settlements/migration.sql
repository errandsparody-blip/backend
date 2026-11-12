-- 0083_admin_settlements
--
-- USA + Canada (Phases 7 & 8). Admin earnings settlements — fulfillment and
-- storage payouts to operational admins, with the fee rates captured at
-- creation (so edits to the rates never rewrite history) and the payment-
-- receipt lifecycle (PENDING → PAID_AWAITING → CONFIRMED / DISPUTED).
-- New table; existing data unaffected. Fee percentages live in the
-- configuration table (admin_platform_fee_bps / admin_processing_fee_bps).

CREATE TYPE "AdminSettlementKind" AS ENUM ('FULFILLMENT', 'STORAGE');
CREATE TYPE "AdminSettlementStatus" AS ENUM ('PENDING', 'PAID_AWAITING', 'CONFIRMED', 'DISPUTED');

CREATE TABLE "admin_settlements" (
  "id"                   UUID NOT NULL DEFAULT gen_random_uuid(),
  "admin_user_id"        UUID NOT NULL,
  "kind"                 "AdminSettlementKind" NOT NULL,
  "period_start"         TIMESTAMP(3) NOT NULL,
  "period_end"           TIMESTAMP(3) NOT NULL,
  "gross_cents"          INTEGER NOT NULL,
  "platform_fee_cents"   INTEGER NOT NULL DEFAULT 0,
  "processing_fee_cents" INTEGER NOT NULL DEFAULT 0,
  "net_cents"            INTEGER NOT NULL,
  "platform_fee_bps"     INTEGER NOT NULL DEFAULT 0,
  "processing_fee_bps"   INTEGER NOT NULL DEFAULT 0,
  "status"               "AdminSettlementStatus" NOT NULL DEFAULT 'PENDING',
  "receipt_url"          TEXT,
  "note"                 TEXT,
  "paid_at"              TIMESTAMP(3),
  "confirmed_at"         TIMESTAMP(3),
  "created_by_id"        UUID,
  "created_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "admin_settlements_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "admin_settlements_admin_user_id_kind_period_start_idx"
  ON "admin_settlements" ("admin_user_id", "kind", "period_start");
CREATE INDEX "admin_settlements_status_idx" ON "admin_settlements" ("status");

ALTER TABLE "admin_settlements"
  ADD CONSTRAINT "admin_settlements_admin_user_id_fkey"
  FOREIGN KEY ("admin_user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
