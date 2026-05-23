-- Migration 0033 — explicit PSN shipping mode.
--
-- Before this migration, "loose vs pallet" was a frontend-only concept; the
-- backend inferred pallet-mode from `declared_box_counts->>'PALLET' > 0`. To
-- support the third mode — ADD_TO_PALLET (top up an existing pallet with new
-- boxes) — we need a real persisted enum, because LOOSE and ADD_TO_PALLET
-- ship with the same `declared_box_counts` shape (box tiers, no PALLET key)
-- and would otherwise be indistinguishable on the wire.
--
-- Modes:
--   LOOSE          — each box pays stocking + first-month storage.
--   PALLET         — creates a new pallet at $45/mo; each box pays stocking
--                    only (the pallet covers storage).
--   ADD_TO_PALLET  — vendor declares boxes to be placed on a pallet they
--                    already have at the warehouse. Pays stocking only —
--                    no new pallet, no recurring storage line (the existing
--                    pallet's $45/mo continues to cover it). Capacity + tier
--                    match are confirmed off-platform with admin (V1 has no
--                    Pallet entity to enforce automatically); admin rejects
--                    the PSN at receive if the boxes don't fit / match.
--
-- Compatibility / grandfathering:
--   - `shipping_mode` is NOT NULL with DEFAULT 'LOOSE' so existing in-flight
--     PSNs land on a deterministic value at migration time.
--   - The backfill below upgrades any historical PSN that declared a pallet
--     to PALLET mode, preserving exact semantic parity with the previous
--     `declared.PALLET > 0` inference. Without this, the storage cron and
--     fee-receipt history would silently diverge from what those PSNs
--     actually charged at the time.
--   - The new mode is opt-in: the Zod schema defaults to LOOSE, so any
--     client that hasn't been updated to send the field keeps working
--     identically to today.
--
-- Indexes:
--   - (vendor_id, shipping_mode) — supports the upcoming admin "vendors
--     with partial pallets" widget (filter PSNs by mode within a vendor).
--     Composite to avoid a separate index on shipping_mode that would
--     scan the whole table for a single mode value.

-- 1. Create the enum (idempotent — Postgres has no CREATE TYPE IF NOT EXISTS).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ShippingMode') THEN
    CREATE TYPE "ShippingMode" AS ENUM ('LOOSE', 'PALLET', 'ADD_TO_PALLET');
  END IF;
END$$;

-- 2. Add the column with a safe default so the NOT NULL constraint is
--    satisfied for every existing row without a separate UPDATE pass.
ALTER TABLE "psns"
  ADD COLUMN IF NOT EXISTS "shipping_mode" "ShippingMode" NOT NULL DEFAULT 'LOOSE';

-- 3. Backfill: any historical PSN that declared a pallet was implicitly
--    in pallet mode under the old inference. Promote those rows so the
--    new explicit column matches what the old code would have computed.
--    Idempotent — re-running this finds zero rows still on the default
--    that still match the predicate.
UPDATE "psns"
SET    "shipping_mode" = 'PALLET'
WHERE  "shipping_mode" = 'LOOSE'
  AND  COALESCE(("declared_box_counts" ->> 'PALLET')::int, 0) > 0;

-- 4. Composite index for future admin queries that filter by mode within
--    a single vendor (e.g. "list this vendor's PALLET PSNs to surface
--    candidate pallets for top-up"). Vendor-scoped first because every
--    such query is already scoped to a single vendor.
CREATE INDEX IF NOT EXISTS "psns_vendor_id_shipping_mode_idx"
  ON "psns" ("vendor_id", "shipping_mode");
