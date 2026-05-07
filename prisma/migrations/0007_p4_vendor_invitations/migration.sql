-- =============================================================================
-- P4.4 — Vendor invitations: defensive checks + email-format guard.
-- =============================================================================

ALTER TABLE "vendor_invitations"
  ADD CONSTRAINT "vendor_invitations_email_format"
    CHECK ("email" ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$');

ALTER TABLE "vendor_invitations"
  ADD CONSTRAINT "vendor_invitations_email_lowercase"
    CHECK ("email" = lower("email"));

-- Active rows must have a future expiry; once revoked or expired, the row
-- becomes immutable in practice. The status column is the source of truth.
ALTER TABLE "vendor_invitations"
  ADD CONSTRAINT "vendor_invitations_revoked_has_timestamp"
    CHECK ("status" <> 'REVOKED' OR "revoked_at" IS NOT NULL);

ALTER TABLE "vendor_invitations"
  ADD CONSTRAINT "vendor_invitations_accepted_has_timestamp"
    CHECK ("status" <> 'ACCEPTED' OR "accepted_at" IS NOT NULL);
