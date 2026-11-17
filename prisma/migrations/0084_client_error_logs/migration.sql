-- 0084_client_error_logs
--
-- Vendor-facing error telemetry. When a signed-in user hits an error in the
-- browser — a failed/blocked API call, a page crash, or an uncaught JS error —
-- the web app POSTs a compact record here so a super-admin can see exactly
-- what a vendor saw WITHOUT logging into their account. Append-only; nothing
-- references it. Retention/pruning is a future concern (a nightly delete of
-- rows older than N days can be added later).

CREATE TABLE "client_error_logs" (
  "id"          UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id"     UUID,
  "vendor_id"   UUID,
  "role"        TEXT,
  -- Coarse bucket: 'api_error' | 'blocked_action' | 'render_error'
  --              | 'window_error' | 'unhandled_rejection'
  "kind"        TEXT NOT NULL,
  "message"     TEXT NOT NULL,
  -- Backend error code when the source was an API response (e.g.
  -- 'address_needs_verification', 'order_country_mismatch').
  "code"        TEXT,
  "status_code" INTEGER,
  -- The app route the user was on (pathname only — never query strings,
  -- which could carry PII).
  "path"        TEXT,
  "stack"       TEXT,
  -- Small structured blob (method, endpoint, component, etc.). Capped
  -- client-side; treated as untrusted.
  "context"     JSONB,
  "user_agent"  TEXT,
  "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "client_error_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "client_error_logs_vendor_id_created_at_idx"
  ON "client_error_logs" ("vendor_id", "created_at");
CREATE INDEX "client_error_logs_created_at_idx"
  ON "client_error_logs" ("created_at");
CREATE INDEX "client_error_logs_kind_idx" ON "client_error_logs" ("kind");
