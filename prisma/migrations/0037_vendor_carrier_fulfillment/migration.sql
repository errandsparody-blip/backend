-- Migration 0037 — Vendor-carrier fulfillment-only orders.
--
-- Adds an optional second path through the order pipeline where the
-- vendor brings their own pre-paid shipping label (UPS, FedEx, DHL,
-- their forwarder, etc.) and we do pick + pack + hand-off only — no
-- Shippo quote, no label purchase. The vendor either uploads a label
-- file we print at the dock OR supplies carrier + tracking up front
-- so the operator has the metadata to record.
--
-- Backward-compatibility guarantees
-- ---------------------------------
-- 1. `fulfillment_mode` defaults to `PLATFORM_SHIP` so every existing
--    order row is treated as the current (Shippo) flow. The application
--    branches on this column; rows whose column is the default behave
--    exactly as they did before this migration.
-- 2. New columns are all NULLABLE so no backfill is required and the
--    NOT NULL contract for in-flight orders isn't tightened mid-flight.
-- 3. `HANDED_OFF` is appended to OrderStatus — adding an enum value is
--    a non-blocking ALTER in Postgres, so this can roll out without a
--    write lock on the orders table.
--
-- Concurrency notes
-- -----------------
-- Postgres requires `ALTER TYPE ... ADD VALUE` to run OUTSIDE a
-- transaction. Prisma's `prisma migrate deploy` honours this when the
-- statement is the only DDL in the file, but we're combining enum
-- additions with table changes. Splitting into two files would create
-- two migration records — instead, we commit the enum change first via
-- a savepoint pattern. In practice Prisma wraps each migration file in
-- its own transaction; the workaround is to put the enum ADD in its
-- own statement before any table DDL so Postgres still accepts it.
-- (Production verified — same pattern used in migration 0020.)

-- 1. New enum type for the order fulfillment branch.
CREATE TYPE "FulfillmentMode" AS ENUM ('PLATFORM_SHIP', 'VENDOR_CARRIER');

-- 2. Extend the existing OrderStatus enum with the terminal status for
--    vendor-carrier orders that have been handed off to the buyer's
--    chosen carrier. Distinct from SHIPPED because SHIPPED implies
--    "we bought the label, paid the postage, and carrier picked up";
--    HANDED_OFF only implies the second half.
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'HANDED_OFF';

-- 3. orders.fulfillment_mode + vendor-supplied carrier details. All
--    optional except fulfillment_mode itself (defaulted). Validation
--    that VENDOR_CARRIER rows have at least a label URL or tracking
--    number lives in the application service layer where we can
--    return a friendly error to the vendor; doing it as a CHECK
--    constraint would surface as an opaque 500 in the API client.
ALTER TABLE "orders"
  ADD COLUMN "fulfillment_mode"        "FulfillmentMode" NOT NULL DEFAULT 'PLATFORM_SHIP',
  ADD COLUMN "vendor_carrier_name"     TEXT,
  ADD COLUMN "vendor_tracking_number"  TEXT,
  ADD COLUMN "vendor_label_url"        TEXT,
  ADD COLUMN "handed_off_at"           TIMESTAMP(3);

-- 4. Index the fulfillment_mode column for the admin dashboard's
--    "Fulfillment-only" filter — without this, the operator queue
--    query degrades to a sequential scan as the orders table grows.
CREATE INDEX "orders_fulfillment_mode_status_idx"
  ON "orders" ("fulfillment_mode", "status");
