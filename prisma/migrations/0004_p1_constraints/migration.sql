-- =============================================================================
-- P1 — defense-in-depth constraints applied after Prisma's auto-migration.
-- Implementation Plan §10.1, §6.1.3.
-- =============================================================================

-- 1) SKU quantities are non-negative at the DB level. Application logic also
-- enforces this, but a CHECK guards against bugs that bypass services.
ALTER TABLE skus
  ADD CONSTRAINT skus_qty_available_nonneg CHECK (quantity_available >= 0),
  ADD CONSTRAINT skus_qty_reserved_nonneg  CHECK (quantity_reserved  >= 0);

-- 2) PSN line counts are non-negative.
ALTER TABLE psn_lines
  ADD CONSTRAINT psn_lines_declared_nonneg CHECK (declared_qty >= 0),
  ADD CONSTRAINT psn_lines_received_nonneg CHECK (received_qty >= 0),
  ADD CONSTRAINT psn_lines_accepted_nonneg CHECK (accepted_qty >= 0),
  ADD CONSTRAINT psn_lines_damaged_nonneg  CHECK (damaged_qty  >= 0);

-- 3) Country codes are 2 uppercase letters.
ALTER TABLE products
  ADD CONSTRAINT products_country_uppercase
    CHECK (country_of_origin = UPPER(country_of_origin) AND length(country_of_origin) = 2);

ALTER TABLE vendors
  ADD CONSTRAINT vendors_country_uppercase
    CHECK (country = UPPER(country) AND length(country) = 2);

-- 4) Declared values are non-negative.
ALTER TABLE products
  ADD CONSTRAINT products_declared_value_nonneg CHECK (declared_value_cents >= 0);

-- 5) Cleanup function for expired idempotency keys. Invoked from a cron job in P2.
CREATE OR REPLACE FUNCTION purge_expired_idempotency_keys() RETURNS integer AS $$
DECLARE
  deleted integer;
BEGIN
  DELETE FROM idempotency_keys WHERE expires_at < NOW();
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$ LANGUAGE plpgsql;
