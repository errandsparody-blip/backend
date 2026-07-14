-- Migration 0042 — Fulfillment v2 pack step + rate cache.
--
-- Adds seven columns to `orders` for the pack step (dimensions,
-- weight, timestamp, actor, notes) and a new `order_shipping_rate_options`
-- table that caches the Shippo rates fetched at pack-completion time,
-- so the admin picker doesn't re-hit the carrier API on every render.
--
-- Everything here is v2-only in *practice* (legacy v1 orders never
-- enter the pack step), but the columns default to NULL and the cache
-- table is fully additive — no legacy path breaks.
--
-- All dimensional units mirror what Shippo takes on the wire:
--   * length/width/height  in INCHES (decimal, 1 fractional digit)
--   * weight               in OUNCES (integer — grams are more accurate
--                          in principle, but our warehouse scales all
--                          report ounces and we don't want a lossy
--                          front-end conversion)
--
-- The rate cache is intentionally CHEAP:
--   * carrier + service are stored as opaque strings (rate-id +
--     provider ref are the only stable pointers for the label buy),
--   * cost is captured in CENTS (integer) so no float math ever
--     touches the wallet gate,
--   * fetched_at lets a future TTL sweep drop stale rows,
--   * ON DELETE CASCADE with the order so cancelling doesn't leak
--     orphan cached rows.
--
-- Index rationale:
--   * (order_id) UNIQUE on nothing — an order may have N rate options.
--   * (order_id, rate_provider_ref) UNIQUE — a rate is picked by
--     provider ref, so duplicates in the cache would let admins
--     select an ambiguous rate. Enforced.
--   * (order_id) plain index for the picker's lookup-by-order query.

BEGIN;

-- ---------------------------------------------------------------------
-- 1. Pack columns on orders
-- ---------------------------------------------------------------------

-- Note: `packed_at` was created in 0001_init (legacy fulfillment
-- timeline column). We reuse it here so the v2 pack step sets the
-- same timestamp legacy consumers already read.
ALTER TABLE "orders"
  ADD COLUMN "packed_length_in"   DECIMAL(6, 1),
  ADD COLUMN "packed_width_in"    DECIMAL(6, 1),
  ADD COLUMN "packed_height_in"   DECIMAL(6, 1),
  ADD COLUMN "packed_weight_oz"   INTEGER,
  ADD COLUMN "packed_by_user_id"  UUID REFERENCES "users"("id") ON DELETE SET NULL,
  ADD COLUMN "packing_notes"      TEXT;

-- All four dimensional / weight columns must be strictly positive when
-- set. A NULL means "not yet packed"; a zero or negative value is
-- always wrong and would corrupt the flat-rate eligibility check.
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_packed_dims_positive"
  CHECK (
    ("packed_length_in"  IS NULL OR "packed_length_in"  > 0) AND
    ("packed_width_in"   IS NULL OR "packed_width_in"   > 0) AND
    ("packed_height_in"  IS NULL OR "packed_height_in"  > 0) AND
    ("packed_weight_oz"  IS NULL OR "packed_weight_oz"  > 0)
  );

-- All-or-nothing: either every pack column is set (pack completed) or
-- every pack column is null (not yet packed). Prevents half-populated
-- rows from a partial failure in the transition service.
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_packed_all_or_none"
  CHECK (
    (
      "packed_length_in" IS NULL AND
      "packed_width_in"  IS NULL AND
      "packed_height_in" IS NULL AND
      "packed_weight_oz" IS NULL AND
      "packed_at"        IS NULL
    ) OR (
      "packed_length_in" IS NOT NULL AND
      "packed_width_in"  IS NOT NULL AND
      "packed_height_in" IS NOT NULL AND
      "packed_weight_oz" IS NOT NULL AND
      "packed_at"        IS NOT NULL
    )
  );

-- Notes are optional but capped so a runaway paste doesn't fill the
-- row. 500 chars matches the audit-log free-text policy elsewhere.
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_packing_notes_len"
  CHECK ("packing_notes" IS NULL OR char_length("packing_notes") <= 500);

-- ---------------------------------------------------------------------
-- 2. Cached shipping rate options
-- ---------------------------------------------------------------------

CREATE TABLE "order_shipping_rate_options" (
  "id"                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "order_id"            UUID NOT NULL REFERENCES "orders"("id") ON DELETE CASCADE,
  "rate_provider_ref"   TEXT NOT NULL,
  "shipment_provider_ref" TEXT NOT NULL,
  "carrier"             TEXT NOT NULL,
  "service"             TEXT NOT NULL,
  "cost_cents"          INTEGER NOT NULL CHECK ("cost_cents" >= 0),
  "estimated_delivery_days" INTEGER NOT NULL CHECK ("estimated_delivery_days" >= 0),
  "fetched_at"          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "order_rate_options_ref_unique"
    UNIQUE ("order_id", "rate_provider_ref"),
  CONSTRAINT "order_rate_options_carrier_len"
    CHECK (char_length("carrier") BETWEEN 1 AND 40),
  CONSTRAINT "order_rate_options_service_len"
    CHECK (char_length("service") BETWEEN 1 AND 60),
  CONSTRAINT "order_rate_options_ref_len"
    CHECK (
      char_length("rate_provider_ref") BETWEEN 1 AND 128 AND
      char_length("shipment_provider_ref") BETWEEN 1 AND 128
    )
);

CREATE INDEX "order_rate_options_order_id_idx"
  ON "order_shipping_rate_options" ("order_id");

CREATE INDEX "order_rate_options_fetched_at_idx"
  ON "order_shipping_rate_options" ("fetched_at");

COMMIT;
