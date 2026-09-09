-- Migration 0062 — vendor custom domains (Phase 3). A vendor can point their
-- own domain (shop.brand.com) at their storefront. App-side registration +
-- DNS-TXT verification live here; DNS records + per-domain SSL are provisioned
-- in infra separately. Additive + idempotent.

CREATE TABLE IF NOT EXISTS "vendor_domains" (
  "id"                 UUID         NOT NULL DEFAULT gen_random_uuid(),
  "vendor_id"          UUID         NOT NULL,
  "host"               TEXT         NOT NULL,
  "status"             TEXT         NOT NULL DEFAULT 'PENDING',
  -- PENDING (awaiting DNS TXT) | VERIFIED (resolvable) | DISABLED
  "verification_token" TEXT         NOT NULL,
  "verified_at"        TIMESTAMP(3),
  "created_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "vendor_domains_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "vendor_domains_vendor_fkey"
    FOREIGN KEY ("vendor_id") REFERENCES "vendors" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
-- A host maps to exactly one vendor.
CREATE UNIQUE INDEX IF NOT EXISTS "vendor_domains_host_key" ON "vendor_domains" (lower("host"));
CREATE INDEX IF NOT EXISTS "vendor_domains_vendor_idx" ON "vendor_domains" ("vendor_id");
CREATE INDEX IF NOT EXISTS "vendor_domains_status_idx" ON "vendor_domains" ("status");
