-- Migration 0035 — Storage boxes
--
-- Replaces the per-SKU storage billing model with per-physical-box
-- billing. Every box we receive at the warehouse becomes one row in
-- `storage_boxes`, with its own tier (size), receive date, and 30-day
-- billing anchor. The cron now iterates this table instead of `skus`.
--
-- Why: a SKU is "vendor + product + variant" (one logical inventory
-- line). The number of physical boxes that line occupies is independent
-- of the SKU count — one box can hold many SKUs, and one SKU can span
-- many boxes. Billing has to follow the boxes, not the SKUs, otherwise
-- vendors either overpay or underpay relative to what the warehouse
-- actually costs us to operate.
--
-- Idempotent throughout — every DDL uses IF NOT EXISTS or a DO block
-- so the migration replays cleanly after a partial failure.

-- 1. Status enum — ACTIVE bills monthly, EMPTY is parked (no charge,
--    not deleted so audit trail is preserved), REMOVED is consolidated
--    out of the warehouse entirely.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'StorageBoxStatus') THEN
    CREATE TYPE "StorageBoxStatus" AS ENUM ('ACTIVE', 'EMPTY', 'REMOVED');
  END IF;
END
$$;

-- 2. storage_boxes table.
--
-- FK columns are UUID to match the parent tables (vendors.id, psns.id,
-- users.id are all UUID). A previous draft of this migration declared
-- them as TEXT and failed with a 42804 type-mismatch error from
-- Postgres; that's been fixed to UUID below.
CREATE TABLE IF NOT EXISTS "storage_boxes" (
  "id"                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "vendor_id"                UUID NOT NULL REFERENCES "vendors"("id") ON DELETE CASCADE,
  "psn_id"                   UUID NOT NULL REFERENCES "psns"("id") ON DELETE RESTRICT,
  "tier"                     "StorageTier" NOT NULL,
  "received_at"              TIMESTAMP(3) NOT NULL,
  "next_billing_date"        DATE NOT NULL,
  "status"                   "StorageBoxStatus" NOT NULL DEFAULT 'ACTIVE',

  -- Pallet contents — only populated when tier = 'PALLET'. A pallet
  -- is itself a container; these fields describe what's inside so the
  -- vendor / admin sees "PALLET — 8 LARGE boxes inside" rather than
  -- a bare "PALLET" line with no context. Null otherwise.
  "pallet_content_tier"      "StorageTier" NULL,
  "pallet_content_count"     INTEGER NULL,

  -- Operator note attached when an admin marks the box empty or
  -- removes it ("consolidated into box X", "vendor confirmed empty
  -- by phone", etc.). Null while the box is ACTIVE.
  "status_note"              TEXT NULL,
  "status_changed_at"        TIMESTAMP(3) NULL,
  "status_changed_by"        UUID NULL REFERENCES "users"("id") ON DELETE SET NULL,

  "created_at"               TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updated_at"               TIMESTAMP(3) NOT NULL DEFAULT now()
);

-- 3. Indexes — the cron query is the hot path, so make sure
--    (status, next_billing_date) is indexed. Per-vendor lookups
--    (recurring page, admin vendor detail) also need indexing.
CREATE INDEX IF NOT EXISTS "storage_boxes_vendor_id_status_idx"
  ON "storage_boxes" ("vendor_id", "status");

CREATE INDEX IF NOT EXISTS "storage_boxes_status_next_billing_date_idx"
  ON "storage_boxes" ("status", "next_billing_date");

CREATE INDEX IF NOT EXISTS "storage_boxes_psn_id_idx"
  ON "storage_boxes" ("psn_id");

-- 4. Backfill. For every PSN that has already been received, create
--    one StorageBox row per declared box. The vendor's
--    declaredBoxCounts JSON gives the per-tier count; we generate
--    that many rows per tier.
--
--    next_billing_date = received_at + 30 days. This is the same
--    grace-period rule new boxes will use going forward, so existing
--    inventory transitions to the new model with continuity (no
--    surprise overdue charges, no resetting the clock).
--
--    The `generate_series` trick generates one row per box. We cast
--    received_at to date and add 30 days for next_billing_date.
--
--    Pallet contents (pallet_content_tier / pallet_content_count) are
--    left null — historical PSNs didn't capture per-pallet contents,
--    so admins will fill those in from the consolidate dialog later.

INSERT INTO "storage_boxes" (
  "id",
  "vendor_id",
  "psn_id",
  "tier",
  "received_at",
  "next_billing_date",
  "status"
)
SELECT
  gen_random_uuid()                                      AS id,
  p."vendor_id"                                          AS vendor_id,
  p."id"                                                 AS psn_id,
  tier_entry.tier::"StorageTier"                         AS tier,
  p."received_at"                                        AS received_at,
  (p."received_at"::date + INTERVAL '30 days')::date     AS next_billing_date,
  'ACTIVE'::"StorageBoxStatus"                           AS status
FROM "psns" p
CROSS JOIN LATERAL (
  -- Unwrap declaredBoxCounts {SMALL: 2, MEDIUM: 1, ...} → one row
  -- per declared box. value::int is the count for that tier; we
  -- multiply with generate_series to fan it out.
  SELECT
    key  AS tier,
    generate_series(1, value::int) AS box_n
  FROM jsonb_each_text(p."declared_box_counts")
  WHERE value::int > 0
) AS tier_entry
WHERE p."received_at" IS NOT NULL
  AND p."status" IN ('RECEIVED', 'PARTIALLY_RECEIVED', 'DISCREPANCY')
  -- Idempotency guard: only backfill if no boxes exist for this PSN yet.
  -- Lets the migration replay cleanly after a partial failure.
  AND NOT EXISTS (
    SELECT 1 FROM "storage_boxes" sb WHERE sb."psn_id" = p."id"
  );
