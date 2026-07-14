-- Migration 0045 — Warehouse inventory locations.
--
-- Structured storage locations (aisle / bay / shelf / bin). A SKU
-- can be assigned to at most one location via `skus.location_id`
-- (nullable). Warehouse operators see the location on pick/pack
-- and PSN receive UIs so they can walk to the item directly.
--
-- Design decisions:
--   * `code` is the human-facing identifier (e.g. A-01-03-B). Enforced
--     UPPERCASE + digits + hyphens by regex; UNIQUE so the shortcut
--     `getByCode` never returns an ambiguous row.
--   * The hierarchical fields (aisle / bay / shelf / bin) are all
--     nullable strings so a warehouse can adopt as many levels as
--     they want without a schema change. Sorting is by `sort_order`
--     rather than any implicit alpha ordering, so operators can
--     force a natural walking sequence.
--   * `is_active` gates the picker; deactivated locations stay in
--     the table so historical SKU assignments never lose their FK.
--   * ON DELETE SET NULL on `skus.location_id` — retiring a
--     location strips the assignment from every SKU rather than
--     cascading a delete on inventory.

BEGIN;

CREATE TABLE "inventory_locations" (
  "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "code"        VARCHAR(32) NOT NULL,
  "label"       VARCHAR(80) NOT NULL,
  "aisle"       VARCHAR(16),
  "bay"         VARCHAR(16),
  "shelf"       VARCHAR(16),
  "bin"         VARCHAR(16),
  "is_active"   BOOLEAN NOT NULL DEFAULT TRUE,
  "sort_order"  INTEGER NOT NULL DEFAULT 100,
  "notes"       VARCHAR(280),
  "created_at"  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at"  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT "inventory_locations_code_unique" UNIQUE ("code"),
  CONSTRAINT "inventory_locations_code_format"
    CHECK ("code" ~ '^[A-Z0-9-]{2,32}$'),
  CONSTRAINT "inventory_locations_label_len"
    CHECK (char_length("label") BETWEEN 1 AND 80),
  CONSTRAINT "inventory_locations_sort_bounds"
    CHECK ("sort_order" >= 0 AND "sort_order" <= 10000)
);

CREATE INDEX "inventory_locations_active_sort_idx"
  ON "inventory_locations" ("is_active", "sort_order", "code");

-- SKU → location FK. Nullable; SET NULL on delete so retiring a
-- location strips assignments without cascading a delete on skus.
ALTER TABLE "skus"
  ADD COLUMN "location_id" UUID
    REFERENCES "inventory_locations"("id") ON DELETE SET NULL;

CREATE INDEX "skus_location_id_idx" ON "skus" ("location_id");

COMMIT;
