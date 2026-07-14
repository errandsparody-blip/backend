-- Migration 0047 — Fulfillment v1 abolition tombstone.
--
-- The v2 spec ("Studio mvp task 71326.pdf", page 8) mandates the
-- v1 flow be abolished entirely. The application code has been
-- updated so that every submit runs the v2 machine unconditionally
-- and the `fulfillment_v2_enabled` config row is no longer read.
--
-- This migration:
--   * Upserts the config row to `true` so any environment that
--     already ran the earlier `false` seed doesn't lag behind a
--     hypothetical rollback. It's now purely a record; nothing
--     reads it.
--   * Updates the row's description to make its purpose explicit
--     to any operator browsing the configuration table in psql.
--
-- Kept as an UPSERT rather than a DELETE so historical audit logs
-- that reference the config key still resolve to a live row. Drop
-- the row entirely in a future migration after two release cycles
-- of stability.

BEGIN;

INSERT INTO "configuration" ("key", "value", "description", "updated_at")
VALUES (
  'fulfillment_v2_enabled',
  'true'::jsonb,
  'TOMBSTONE (Migration 0047): Fulfillment v1 has been abolished per the v2 spec. Application code no longer reads this row; it is retained only for audit-log continuity. Every order runs v2 unconditionally.',
  NOW()
)
ON CONFLICT ("key") DO UPDATE
SET "value" = 'true'::jsonb,
    "description" = EXCLUDED."description",
    "updated_at" = NOW();

COMMIT;
