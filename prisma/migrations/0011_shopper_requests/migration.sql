-- =============================================================================
-- 0011 — Personal Shopper feature.
--
-- A separate product line from the vendor : any visitor pastes a product
-- link, pays upfront for items + commission, the platform procures and
-- ships, all coordinated through an email-tied chat thread.
--
-- Architecture notes:
--   * No vendor in the loop. The platform is the merchant of record for
--     the *service*, not for the third-party product.
--   * Buyers don't have User rows. They're tied to an email + a magic-link
--     access token (long-lived, hashed in DB, re-issuable).
--   * Two-payment flow:
--       1. Intake payment   = items_subtotal + commission (Stripe Checkout)
--       2. Follow-up payment = (actual_items - estimated_items) + shipping
--          - positive → buyer pays via Stripe Checkout
--          - negative → admin refunds via Stripe Refund API
--          - zero     → status advances directly to READY_TO_SHIP
--   * Commission rate is a configuration row so admin can tune it without
--     a deploy. Snapshotted onto the request at intake so historical
--     audits remain accurate after rate changes.
-- =============================================================================

-- 1. Status enum -------------------------------------------------------------

CREATE TYPE "ShopperRequestStatus" AS ENUM (
  'AWAITING_INTAKE_PAYMENT',
  'PAID',
  'PROCURING',
  'AWAITING_RECONCILIATION',
  'READY_TO_SHIP',
  'SHIPPED',
  'DELIVERED',
  'CANCELLED',
  'REFUNDED'
);

CREATE TYPE "ShopperMessageSender" AS ENUM ('BUYER', 'ADMIN');

CREATE TYPE "ShopperShippingMethod" AS ENUM (
  'PLATFORM_FREIGHT',     -- USA Errands buys carrier label and ships directly
  'BUYER_FORWARDER',      -- buyer provides a US forwarder address; admin ships there
  'PICKUP'                -- buyer picks up from the warehouse (rare)
);

-- 2. Main request table ------------------------------------------------------

CREATE TABLE "shopper_requests" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Buyer identity (no User row)
  "buyer_email" TEXT NOT NULL,
  "buyer_name"  TEXT,

  -- Shipping (optional at intake; admin captures in chat if missing)
  "shipping_address"   JSONB,
  "shipping_method"    "ShopperShippingMethod",
  "tracking_number"    TEXT,
  "carrier"            TEXT,
  "shipped_at"         TIMESTAMPTZ,
  "delivered_at"       TIMESTAMPTZ,

  -- Money — intake (paid upfront based on buyer's estimates)
  "items_subtotal_cents"        INTEGER NOT NULL CHECK ("items_subtotal_cents" >= 0),
  "commission_rate_bps"         INTEGER NOT NULL CHECK ("commission_rate_bps" >= 0 AND "commission_rate_bps" <= 10000),
  "commission_cents"            INTEGER NOT NULL CHECK ("commission_cents" >= 0),
  "intake_total_cents"          INTEGER NOT NULL CHECK ("intake_total_cents" >= 0),
  "intake_stripe_session_id"    TEXT,
  "intake_stripe_intent_id"     TEXT,
  "intake_paid_at"              TIMESTAMPTZ,

  -- Money — reconciliation (after admin procures, knows actuals + shipping)
  "items_actual_subtotal_cents" INTEGER CHECK ("items_actual_subtotal_cents" IS NULL OR "items_actual_subtotal_cents" >= 0),
  "shipping_cost_cents"         INTEGER CHECK ("shipping_cost_cents" IS NULL OR "shipping_cost_cents" >= 0),
  "followup_amount_cents"       INTEGER, -- signed: positive = buyer owes more, negative = admin refunds, zero = no action needed
  "followup_stripe_session_id"  TEXT,
  "followup_stripe_intent_id"   TEXT,
  "followup_stripe_refund_id"   TEXT,
  "followup_resolved_at"        TIMESTAMPTZ,

  -- State
  "status"             "ShopperRequestStatus" NOT NULL DEFAULT 'AWAITING_INTAKE_PAYMENT',
  "assigned_admin_id"  UUID,

  -- Free-text notes scoped to the admin (not chat)
  "internal_notes"     TEXT,

  "created_at"         TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"         TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT "shopper_requests_assigned_admin_id_fkey"
    FOREIGN KEY ("assigned_admin_id") REFERENCES "users"("id") ON DELETE SET NULL
);

CREATE INDEX "shopper_requests_buyer_email_created_at_idx"
  ON "shopper_requests" ("buyer_email", "created_at");
CREATE INDEX "shopper_requests_status_created_at_idx"
  ON "shopper_requests" ("status", "created_at");
CREATE INDEX "shopper_requests_assigned_admin_id_status_idx"
  ON "shopper_requests" ("assigned_admin_id", "status");

-- 3. Per-line items (multi-product cart) -------------------------------------

CREATE TABLE "shopper_request_lines" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "request_id" UUID NOT NULL,

  "product_url"             TEXT NOT NULL,
  "product_title"           TEXT,           -- admin can fill in
  "product_notes"           TEXT,           -- buyer's special instructions ("size M, color black")
  "quantity"                INTEGER NOT NULL CHECK ("quantity" > 0),

  -- Money per line
  "estimated_unit_price_cents" INTEGER NOT NULL CHECK ("estimated_unit_price_cents" >= 0),
  "actual_unit_price_cents"    INTEGER CHECK ("actual_unit_price_cents" IS NULL OR "actual_unit_price_cents" >= 0),

  -- Per-line procurement state
  "procurement_status"      TEXT,           -- 'pending' | 'purchased' | 'unavailable' | 'substituted'
  "procurement_notes"       TEXT,

  "created_at"              TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"              TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT "shopper_request_lines_request_id_fkey"
    FOREIGN KEY ("request_id") REFERENCES "shopper_requests"("id") ON DELETE CASCADE
);

CREATE INDEX "shopper_request_lines_request_id_idx"
  ON "shopper_request_lines" ("request_id");

-- 4. Chat messages -----------------------------------------------------------

CREATE TABLE "shopper_messages" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "request_id" UUID NOT NULL,

  "sender" "ShopperMessageSender" NOT NULL,
  "sender_user_id" UUID,        -- non-null for ADMIN messages, references users(id)
  "body" TEXT NOT NULL CHECK (length("body") > 0 AND length("body") <= 10000),
  "attachment_urls" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],

  "read_by_buyer_at" TIMESTAMPTZ,
  "read_by_admin_at" TIMESTAMPTZ,

  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT "shopper_messages_request_id_fkey"
    FOREIGN KEY ("request_id") REFERENCES "shopper_requests"("id") ON DELETE CASCADE,
  CONSTRAINT "shopper_messages_sender_user_id_fkey"
    FOREIGN KEY ("sender_user_id") REFERENCES "users"("id") ON DELETE SET NULL,

  -- Sanity: ADMIN messages must have a sender_user_id; BUYER messages must not.
  CONSTRAINT "shopper_messages_sender_user_id_consistency"
    CHECK (
      ("sender" = 'ADMIN' AND "sender_user_id" IS NOT NULL) OR
      ("sender" = 'BUYER' AND "sender_user_id" IS NULL)
    )
);

CREATE INDEX "shopper_messages_request_id_created_at_idx"
  ON "shopper_messages" ("request_id", "created_at");

-- 5. Magic-link access tokens -----------------------------------------------

CREATE TABLE "shopper_access_tokens" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "request_id" UUID NOT NULL,
  "token_hash" TEXT NOT NULL UNIQUE,
  "expires_at" TIMESTAMPTZ NOT NULL,
  "last_used_at" TIMESTAMPTZ,
  "revoked_at"   TIMESTAMPTZ,
  "created_at"   TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT "shopper_access_tokens_request_id_fkey"
    FOREIGN KEY ("request_id") REFERENCES "shopper_requests"("id") ON DELETE CASCADE
);

CREATE INDEX "shopper_access_tokens_request_id_idx"
  ON "shopper_access_tokens" ("request_id");

-- 6. Default commission config row ------------------------------------------
--
-- Insert at 1800 bps (18%). The /admin/config/policy editor we already
-- built can be extended to surface this as a friendly form field, but
-- until then it's editable via the JSON editor at /admin/config/[key].

INSERT INTO "configuration" ("key", "description", "value", "updated_at")
VALUES (
  'shopper_commission_bps',
  'Personal shopper service: platform commission as basis points of the items subtotal. 1800 = 18%.',
  '1800'::jsonb,
  now()
)
ON CONFLICT ("key") DO NOTHING;
