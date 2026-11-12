-- =============================================================================
-- VENDOR_CARRIER (own-label) orders may be submitted with a name-only
-- recipient — the vendor's own label carries the destination, so the order
-- row stores empty strings for the address columns.
--
-- Two address CHECKs from 0006 rejected those rows (check_violation → 500 on
-- submit): a US order needed a 2-letter state, and every order needed a
-- non-blank postal code. Keep both guards for PLATFORM_SHIP (we buy the
-- label, so the address must be real) and exempt VENDOR_CARRIER.
--
-- Numbered 0082 so it doesn't collide with in-progress migrations 0077–0081.
-- =============================================================================

ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orders_us_state_uppercase";
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_us_state_uppercase"
    CHECK (
      "fulfillment_mode" = 'VENDOR_CARRIER'
      OR "ship_country" <> 'US'
      OR "ship_state" ~ '^[A-Z]{2}$'
    );

ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orders_postal_code_nonblank";
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_postal_code_nonblank"
    CHECK (
      "fulfillment_mode" = 'VENDOR_CARRIER'
      OR length(btrim("ship_postal_code")) > 0
    );
