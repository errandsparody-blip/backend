-- 0078_usa_canada_admins
--
-- USA + Canada operational control (Phase 1).
--
--   * users.admin_country — the country an operational ADMIN is scoped to
--     (US / CA). NULL for vendors, sub-users and SUPER_ADMIN.
--   * orders.processing_user_id / processing_claimed_at — soft claim so one
--     admin works an order at a time, and we record who processed it.
--   * vendor_admin_assignments — maps a vendor to its operational admin per
--     country (at most one admin per vendor per country).
--
-- All additive; existing rows are unaffected (new columns are nullable, new
-- table is empty).

ALTER TABLE "users"  ADD COLUMN "admin_country"        CHAR(2);
ALTER TABLE "orders" ADD COLUMN "processing_user_id"   UUID;
ALTER TABLE "orders" ADD COLUMN "processing_claimed_at" TIMESTAMP(3);

CREATE TABLE "vendor_admin_assignments" (
  "id"            UUID NOT NULL DEFAULT gen_random_uuid(),
  "vendor_id"     UUID NOT NULL,
  "country"       CHAR(2) NOT NULL,
  "admin_user_id" UUID NOT NULL,
  "assigned_by_id" UUID,
  "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "vendor_admin_assignments_pkey" PRIMARY KEY ("id")
);

-- One operational admin per vendor per country.
CREATE UNIQUE INDEX "vendor_admin_assignments_vendor_id_country_key"
  ON "vendor_admin_assignments" ("vendor_id", "country");
CREATE INDEX "vendor_admin_assignments_admin_user_id_idx"
  ON "vendor_admin_assignments" ("admin_user_id");
CREATE INDEX "vendor_admin_assignments_country_idx"
  ON "vendor_admin_assignments" ("country");

ALTER TABLE "vendor_admin_assignments"
  ADD CONSTRAINT "vendor_admin_assignments_vendor_id_fkey"
  FOREIGN KEY ("vendor_id") REFERENCES "vendors" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "vendor_admin_assignments"
  ADD CONSTRAINT "vendor_admin_assignments_admin_user_id_fkey"
  FOREIGN KEY ("admin_user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "vendor_admin_assignments"
  ADD CONSTRAINT "vendor_admin_assignments_assigned_by_id_fkey"
  FOREIGN KEY ("assigned_by_id") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Attribute processing to a user for dashboards/filters.
CREATE INDEX "orders_processing_user_id_idx" ON "orders" ("processing_user_id");
