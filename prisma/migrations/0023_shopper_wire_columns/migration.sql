-- Migration 0023 — wire-transfer + ID-verification columns + config seeds.
--
-- Companion to 0023a (which added the new status values). This migration
-- adds:
--
--   1. Two brand-new enums:
--        - ShopperPaymentMethod (STRIPE | WIRE)
--        - ShopperIdVerificationStatus (NONE | PENDING_UPLOAD | UNDER_REVIEW
--                                       | APPROVED | REJECTED)
--      CREATE TYPE in the same transaction as a column DEFAULT that uses
--      the new type IS safe (the 55P04 restriction only applies to
--      ALTER TYPE ... ADD VALUE on pre-existing enums).
--
--   2. Eleven new columns on shopper_requests covering the buyer phone
--      number, the payment-method selection, the ID-verification packet
--      (document URL, selfie URL, status, rejection reason, verifier id +
--      timestamp), and the wire-payment packet (proof URL + timestamp +
--      confirmation user + timestamp).
--
--   3. Two new configuration rows:
--        - shopper_wire_threshold_cents — the items-subtotal value above
--          which a buyer is routed onto the WIRE track. Default 100000
--          (= $1,000). Stored as a JSON number so the existing admin
--          config UI can edit it without code changes.
--        - shopper_bank_instructions — the bank details rendered on the
--          buyer's thread page after their ID is approved. JSON object
--          with empty defaults so this seed never leaks any real account
--          info; finance fills the row in via the admin config page
--          BEFORE turning the wire flow on in production.
--
-- Safety considerations:
--   - Every new column is nullable (or has a sensible default), so the
--     migration never touches existing rows.
--   - Foreign keys to `users` use ON DELETE SET NULL so deleting a
--     verifier doesn't cascade-wipe historical requests.
--   - No CHECK constraints added — application-layer Zod is authoritative
--     and a CHECK would complicate future changes to the enum membership.
--
-- Forward-only. Reversible by dropping the columns + types + config rows
-- if a rollback is ever needed (we'd have to clear the new status values
-- from in-flight rows first, but nothing's there yet on a fresh deploy).

-- 1. New enums --------------------------------------------------------------

CREATE TYPE "ShopperPaymentMethod" AS ENUM ('STRIPE', 'WIRE');

CREATE TYPE "ShopperIdVerificationStatus" AS ENUM (
  'NONE',
  'PENDING_UPLOAD',
  'UNDER_REVIEW',
  'APPROVED',
  'REJECTED'
);

-- 2. shopper_requests column extensions -------------------------------------

ALTER TABLE "shopper_requests"
  -- Required at the application layer for all NEW requests, but nullable
  -- here so we don't have to backfill historical rows. The Zod schema is
  -- the gate.
  ADD COLUMN "buyer_phone" TEXT,

  -- Server-derived; never trust the client. Defaults to STRIPE so any row
  -- somehow created before this migration's app changes lands on the
  -- existing flow rather than getting stuck waiting on a wire.
  ADD COLUMN "payment_method" "ShopperPaymentMethod" NOT NULL DEFAULT 'STRIPE',

  -- ID verification packet ---------------------------------------------------
  ADD COLUMN "id_verification_status" "ShopperIdVerificationStatus"
    NOT NULL DEFAULT 'NONE',
  ADD COLUMN "id_document_url" TEXT,
  ADD COLUMN "id_selfie_url" TEXT,
  ADD COLUMN "id_rejection_reason" TEXT,
  ADD COLUMN "id_verified_at" TIMESTAMP(3),
  ADD COLUMN "id_verified_by" UUID,

  -- Wire payment packet ------------------------------------------------------
  ADD COLUMN "wire_proof_url" TEXT,
  ADD COLUMN "wire_proof_uploaded_at" TIMESTAMP(3),
  ADD COLUMN "wire_confirmed_at" TIMESTAMP(3),
  ADD COLUMN "wire_confirmed_by" UUID;

-- Foreign keys for the audit columns. SET NULL so deleting a verifier
-- account doesn't cascade-wipe any historical wire-approved request.
ALTER TABLE "shopper_requests"
  ADD CONSTRAINT "shopper_requests_id_verified_by_fkey"
    FOREIGN KEY ("id_verified_by") REFERENCES "users"("id") ON DELETE SET NULL;

ALTER TABLE "shopper_requests"
  ADD CONSTRAINT "shopper_requests_wire_confirmed_by_fkey"
    FOREIGN KEY ("wire_confirmed_by") REFERENCES "users"("id") ON DELETE SET NULL;

-- Helpful index for the admin "show me ID/wire reviews" queue queries.
-- Partial indexes keep them small — they only cover rows currently in a
-- review state, which is the only time we filter on these columns.
CREATE INDEX "shopper_requests_id_review_idx"
  ON "shopper_requests" ("id_verification_status", "created_at")
  WHERE "id_verification_status" IN ('PENDING_UPLOAD', 'UNDER_REVIEW');

CREATE INDEX "shopper_requests_wire_track_idx"
  ON "shopper_requests" ("payment_method", "status", "created_at")
  WHERE "payment_method" = 'WIRE';

-- 3. Config seeds -----------------------------------------------------------
--
-- INSERT … ON CONFLICT DO NOTHING — re-running this migration on an
-- environment where finance has already typed in real bank details must
-- NOT clobber them. The default values are intentionally empty so a
-- careless preview environment doesn't accidentally surface someone
-- else's account numbers.

INSERT INTO "configuration" ("key", "value", "description", "updated_at")
VALUES
  (
    'shopper_wire_threshold_cents',
    to_jsonb(100000::int),
    'Personal-shopper items-subtotal threshold above which the buyer is routed to the wire-transfer + ID-verification track. Cents. Default $1,000.',
    NOW()
  ),
  (
    'shopper_bank_instructions',
    '{
      "beneficiaryName": "",
      "bankName": "",
      "accountNumber": "",
      "routingNumber": "",
      "swift": "",
      "iban": "",
      "memo": "Include your reference (SHP-…) in the wire memo so we can reconcile your payment quickly.",
      "notes": ""
    }'::jsonb,
    'Bank-transfer instructions rendered on the buyer thread page AFTER their ID is APPROVED and admin issues a quote. Must never be shown publicly on the intake form. Empty strings by default — finance fills these via the admin config page before enabling the wire flow.',
    NOW()
  )
ON CONFLICT ("key") DO NOTHING;
