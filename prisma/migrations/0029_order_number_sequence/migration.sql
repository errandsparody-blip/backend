-- Migration 0029 — sequential, human-friendly order numbers.
--
-- Up until now the vendor-facing "order number" was either the vendor's own
-- `external_reference` or, if they didn't set one, the first 8 hex chars of
-- the order's UUID (e.g. "1a2b3c4d"). The UUID slice is opaque, hard to read
-- aloud, and makes it impossible for a vendor to tell whether two refs are
-- one apart or a thousand apart.
--
-- This migration introduces a monotonic, globally-unique integer per order
-- that renders as "#1001", "#1002", ... in the UI / emails / receipts. The
-- column is backed by a Postgres SEQUENCE so concurrent inserts can't
-- collide and we never have to read MAX() in app code.
--
-- Why start at 1001:
--   - small numerical head-start so the very first order isn't "#1"
--     (looks better in screenshots, mail clients, dashboards)
--   - existing rows are backfilled in created_at order starting at 1001,
--     preserving a stable chronology
--
-- Idempotent / safe to re-run? No — Prisma's migrate-deploy tracks success
-- in `_prisma_migrations` so this only ever runs once. Within the migration
-- we use IF NOT EXISTS guards on the optional bits so a half-applied state
-- (e.g. column added but sequence not yet created) self-heals on retry.

-- 1. Column added nullable so the backfill can populate it.
ALTER TABLE "orders"
  ADD COLUMN IF NOT EXISTS "order_number" INTEGER;

-- 2. Sequence — separate object so it survives the column being detached
--    later if we ever want to migrate to a different generation strategy.
CREATE SEQUENCE IF NOT EXISTS "orders_order_number_seq" START WITH 1001;

-- 3. Backfill in chronological order. Stable tiebreaker by id so a re-run
--    on a freshly cloned db (e.g. staging from a snapshot) lands the same
--    numbers. Offset is +1000 so the first backfilled row is #1001 and the
--    sequence advances from there.
WITH numbered AS (
  SELECT id,
         ROW_NUMBER() OVER (ORDER BY created_at, id) AS rn
  FROM "orders"
  WHERE "order_number" IS NULL
)
UPDATE "orders" o
SET "order_number" = numbered.rn + 1000
FROM numbered
WHERE o.id = numbered.id;

-- 4. Advance the sequence past the highest backfilled value so the next
--    insert (which the application leaves blank, relying on DEFAULT) gets
--    a brand-new, non-colliding number. setval(..., x, false) makes the
--    NEXT nextval() return x, which is exactly what we want.
SELECT setval(
  'orders_order_number_seq',
  COALESCE((SELECT MAX("order_number") FROM "orders"), 1000) + 1,
  false
);

-- 5. Lock down: NOT NULL + UNIQUE + DEFAULT pointing at the sequence.
ALTER TABLE "orders" ALTER COLUMN "order_number" SET NOT NULL;
ALTER TABLE "orders" ALTER COLUMN "order_number"
  SET DEFAULT nextval('orders_order_number_seq');

-- Tie the sequence's lifetime to the column. If the column is dropped
-- later, the sequence goes with it. Prevents orphan sequences.
ALTER SEQUENCE "orders_order_number_seq" OWNED BY "orders"."order_number";

-- UNIQUE prevents a backfill bug or future race from producing duplicate
-- display numbers. The btree backing the unique constraint also serves
-- look-ups when an admin pastes "#1625" into a search box.
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_order_number_unique" UNIQUE ("order_number");
