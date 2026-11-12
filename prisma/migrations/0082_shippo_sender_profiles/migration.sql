-- 0082_shippo_sender_profiles
--
-- USA + Canada (Phase 10). Shippo "ship from" sender profiles — one per
-- operational admin (keyed by the admin's user id) plus a "DEFAULT" row. The
-- label-buy path uses the processing admin's profile, falling back to DEFAULT,
-- then to the env warehouse address. Empty by default, so label behaviour is
-- unchanged until a SUPER_ADMIN creates profiles. Additive, non-breaking.

CREATE TABLE "shippo_sender_profiles" (
  "id"          UUID NOT NULL DEFAULT gen_random_uuid(),
  "key"         TEXT NOT NULL,
  "label"       TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "phone"       TEXT NOT NULL,
  "email"       TEXT NOT NULL,
  "line1"       TEXT NOT NULL,
  "line2"       TEXT,
  "city"        TEXT NOT NULL,
  "state"       TEXT NOT NULL,
  "postal_code" TEXT NOT NULL,
  "country"     CHAR(2) NOT NULL DEFAULT 'US',
  "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "shippo_sender_profiles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "shippo_sender_profiles_key_key" ON "shippo_sender_profiles" ("key");
