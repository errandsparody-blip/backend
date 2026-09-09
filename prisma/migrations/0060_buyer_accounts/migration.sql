-- Migration 0060 — optional buyer accounts for the storefront (Migration 0059
-- follow-up). Buyers can shop as guests (email only); an account just saves
-- their details for faster future checkout and lets them see order history.
--
-- Auth is passwordless: a magic link issues a short-lived session. Only token
-- HASHES are stored. Additive + idempotent.

CREATE TABLE IF NOT EXISTS "buyer_accounts" (
  "id"                   UUID         NOT NULL DEFAULT gen_random_uuid(),
  "email"                TEXT         NOT NULL,
  "name"                 TEXT,
  "phone"                TEXT,
  "default_ship_address" JSONB,
  "created_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "buyer_accounts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "buyer_accounts_email_key" ON "buyer_accounts" ("email");

CREATE TABLE IF NOT EXISTS "buyer_login_tokens" (
  "id"               UUID         NOT NULL DEFAULT gen_random_uuid(),
  "buyer_account_id" UUID         NOT NULL,
  "token_hash"       TEXT         NOT NULL,
  "expires_at"       TIMESTAMP(3) NOT NULL,
  "consumed_at"      TIMESTAMP(3),
  "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "buyer_login_tokens_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "buyer_login_tokens_account_fkey"
    FOREIGN KEY ("buyer_account_id") REFERENCES "buyer_accounts" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "buyer_login_tokens_token_hash_key" ON "buyer_login_tokens" ("token_hash");
CREATE INDEX IF NOT EXISTS "buyer_login_tokens_account_idx" ON "buyer_login_tokens" ("buyer_account_id");

CREATE TABLE IF NOT EXISTS "buyer_sessions" (
  "id"               UUID         NOT NULL DEFAULT gen_random_uuid(),
  "buyer_account_id" UUID         NOT NULL,
  "token_hash"       TEXT         NOT NULL,
  "expires_at"       TIMESTAMP(3) NOT NULL,
  "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "buyer_sessions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "buyer_sessions_account_fkey"
    FOREIGN KEY ("buyer_account_id") REFERENCES "buyer_accounts" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "buyer_sessions_token_hash_key" ON "buyer_sessions" ("token_hash");
CREATE INDEX IF NOT EXISTS "buyer_sessions_account_idx" ON "buyer_sessions" ("buyer_account_id");
