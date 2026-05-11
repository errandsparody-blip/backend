-- =============================================================================
-- 0018 — Return attachments + return-window seed.
--
-- Two unrelated additions bundled into one migration so the matching
-- backend service code can land atomically:
--
--   1. attachment_urls TEXT[] on returns — vendors attach 0–5 photos /
--      receipts at RMA creation. Inspector sees them on the admin
--      detail page so "defective / arrived damaged" claims are
--      defensible. Defaults to '{}' so existing rows are valid.
--
--   2. returns_window_days configuration row — the maximum age (in
--      days, since order.delivered_at) at which a vendor can still
--      open an RMA. 30 days matches Amazon FBA's default; admins
--      tweak via /admin/config.
--
-- Both pieces are nullable / defaulted so the migration is safe to
-- ship without backfill.
-- =============================================================================

ALTER TABLE "returns"
  ADD COLUMN "attachment_urls" TEXT[] NOT NULL DEFAULT '{}';

INSERT INTO "configuration" ("key", "value", "description", "updated_at")
  VALUES (
    'returns_window_days',
    '30'::jsonb,
    'Days after delivered_at within which vendors can still open an RMA.',
    NOW()
  )
  ON CONFLICT ("key") DO NOTHING;
