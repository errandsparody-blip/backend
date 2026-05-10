-- =============================================================================
-- 0015 — Personal Shopper human-friendly reference + parent link.
--
-- Adds two fields to shopper_requests:
--
--   reference           — short, unique, human-readable id like SHP-000042.
--                         Backed by a Postgres SEQUENCE so generation is
--                         atomic (no app-side race). Shown in every email,
--                         the buyer thread page header, and the admin queue.
--                         The UUID stays as the primary key for joins; the
--                         reference is purely for humans.
--
--   parent_request_id   — optional FK to a previous request by the same
--                         buyer. Set when the buyer types "previous order
--                         reference" on intake. Lets admin see related
--                         orders + ship them together if practical. Nothing
--                         in the system enforces ordering or batching — it's
--                         informational metadata.
--
-- The reference is NOT an auth token. It appears in emails (which are
-- plaintext through email transport) and in the admin UI. A buyer who
-- wants to link a new request to a prior one needs (a) the reference AND
-- (b) the same email address as the parent — we verify the email match
-- at create time so a stranger can't link to someone else's order.
-- =============================================================================

-- 1. Sequence — single, monotonic, gives us SHP-NNNNNN.
CREATE SEQUENCE IF NOT EXISTS "shopper_reference_seq"
  START WITH 1
  INCREMENT BY 1
  MINVALUE 1
  NO MAXVALUE
  CACHE 1;

-- 2. Add the columns. `reference` defaults to a formatted nextval() so
-- existing rows backfill cleanly.
ALTER TABLE "shopper_requests"
  ADD COLUMN "reference" TEXT
    DEFAULT ('SHP-' || lpad(nextval('shopper_reference_seq')::text, 6, '0')),
  ADD COLUMN "parent_request_id" UUID;

-- 3. Backfill any existing rows (no-op on a fresh deploy, harmless otherwise).
UPDATE "shopper_requests"
SET "reference" = 'SHP-' || lpad(nextval('shopper_reference_seq')::text, 6, '0')
WHERE "reference" IS NULL;

-- 4. Now lock down: NOT NULL, UNIQUE, and the FK on parent.
ALTER TABLE "shopper_requests"
  ALTER COLUMN "reference" SET NOT NULL,
  ADD CONSTRAINT "shopper_requests_reference_key" UNIQUE ("reference"),
  ADD CONSTRAINT "shopper_requests_parent_request_id_fkey"
    FOREIGN KEY ("parent_request_id")
    REFERENCES "shopper_requests"("id")
    ON DELETE SET NULL;

CREATE INDEX "shopper_requests_parent_request_id_idx"
  ON "shopper_requests" ("parent_request_id");

-- 5. Drop the default — new rows will get the reference computed in
-- application code (so we can return it to the caller in the same
-- transaction without a follow-up SELECT). The sequence stays.
ALTER TABLE "shopper_requests"
  ALTER COLUMN "reference" DROP DEFAULT;
