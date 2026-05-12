-- Migration 0024 — PSN per-line "missing" capture + per-PSN chat thread.
--
-- Two related additions that ship together because they both serve the
-- same UX goal: give vendors and admins a way to communicate about
-- discrepancies on an inbound shipment without bouncing into email.
--
-- 1. `psn_lines.missing_quantity` — when the warehouse opens a PSN and
--    counts fewer units than the vendor declared (and the missing ones
--    aren't damaged either — they're simply not in the box), the
--    operator records the number here. Distinct from `damaged_qty`
--    because the financial implication is different (missing might be
--    a courier loss / mispack; damaged is in our hands). For v1 we
--    just record it — no automatic refund logic. Operations decides
--    case-by-case whether a partial credit is owed.
--
-- 2. `psn_messages` — per-PSN chat thread. Mirrors the shape of
--    `shopper_messages`: a sender enum (VENDOR / ADMIN), optional
--    sender_user_id for audit (set on both sides — vendors are real
--    User rows on this surface, unlike shopper buyers), free-text
--    body, attachment URLs, and separate read timestamps per side.
--    Indexed on (psn_id, created_at) so the thread query is one
--    sequential scan.
--
-- Forward-only. All new columns + tables are additive; nothing in the
-- existing PSN flow breaks if this migration deploys but the app
-- pointing at it doesn't yet emit on the new surfaces.

-- 1. PsnLine.missing_quantity ------------------------------------------------

ALTER TABLE "psn_lines"
  -- DEFAULT 0 so existing rows have a usable value without backfill,
  -- and NOT NULL because the receiving flow always wants a number to
  -- subtract against declared_qty for math.
  ADD COLUMN "missing_quantity" INTEGER NOT NULL DEFAULT 0;

-- 2. PsnMessageSender enum + psn_messages table -----------------------------

CREATE TYPE "PsnMessageSender" AS ENUM ('VENDOR', 'ADMIN');

CREATE TABLE "psn_messages" (
  "id"              UUID PRIMARY KEY,
  "psn_id"          UUID NOT NULL REFERENCES "psns"("id") ON DELETE CASCADE,

  "sender"          "PsnMessageSender" NOT NULL,
  -- Sender user id. Always set in practice (both vendors and admins are
  -- real User rows here, unlike shopper buyers), but we allow NULL +
  -- SET NULL so a user deletion doesn't cascade-wipe their history.
  "sender_user_id"  UUID REFERENCES "users"("id") ON DELETE SET NULL,

  "body"            TEXT NOT NULL,
  -- Postgres array of public R2 URLs. Empty array by default so
  -- read code can iterate without a null check.
  "attachment_urls" TEXT[] NOT NULL DEFAULT '{}',

  -- Separate read timestamps per side so the "X unread" badges on each
  -- portal stay accurate. The shopper messages table has the same shape.
  "read_by_vendor_at" TIMESTAMP(3),
  "read_by_admin_at"  TIMESTAMP(3),

  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT now()
);

-- Threaded view is "give me all messages for PSN X in order". Single
-- composite index covers both the FK lookup and the order-by.
CREATE INDEX "psn_messages_psn_created_idx"
  ON "psn_messages" ("psn_id", "created_at");
