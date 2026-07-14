-- Migration 0044 — Product barcodes (Fulfillment v2 scan step).
--
-- Adds a normalized `product_barcodes` table so a product can carry
-- N barcodes (retailer UPC, GTIN14 case code, an internal Code128
-- label, etc.). One barcode may only map to ONE product globally —
-- allowing the same code to point at two different products would
-- defeat the scan-at-pack verification workflow.
--
-- Symbology is an enum rather than free text so the pack scanner
-- can present symbology-appropriate UX (checksum hint, expected
-- length) without an if/else on strings.
--
-- SECURITY / correctness
--   * `barcode` is UNIQUE globally. If a vendor tries to register a
--     code already owned by another vendor's product, the DB refuses
--     — the service returns 409 barcode_taken with a stable code
--     the frontend can pin copy to.
--   * `is_primary` is a hint; multiple non-primary barcodes are
--     fine, but AT MOST one primary per product. Enforced by a
--     partial unique index.
--   * ON DELETE CASCADE with products so retiring a product also
--     drops its barcodes — a stale barcode outliving its product
--     would silently start pointing to "nothing".
--   * A regex CHECK on barcode enforces a printable-ASCII-only
--     payload up to 48 chars. Zero-width or control chars can't
--     be stored (they'd defeat human-readable audit trails).

BEGIN;

-- Enum first so the column can reference it. IF NOT EXISTS keeps
-- this idempotent should the enum ever be split into its own
-- migration.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'BarcodeSymbology') THEN
    CREATE TYPE "BarcodeSymbology" AS ENUM (
      'EAN13',
      'UPC_A',
      'CODE128',
      'GTIN14',
      'OTHER'
    );
  END IF;
END $$;

CREATE TABLE "product_barcodes" (
  "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "product_id"  UUID NOT NULL REFERENCES "products"("id") ON DELETE CASCADE,
  "barcode"     VARCHAR(48) NOT NULL,
  "symbology"   "BarcodeSymbology" NOT NULL DEFAULT 'OTHER',
  "is_primary"  BOOLEAN NOT NULL DEFAULT FALSE,
  "created_by"  UUID REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at"  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT "product_barcodes_barcode_unique" UNIQUE ("barcode"),
  CONSTRAINT "product_barcodes_barcode_len"
    CHECK (char_length("barcode") BETWEEN 1 AND 48),
  -- Printable ASCII only; no whitespace, no control chars. This
  -- rules out invisible characters from bad OCR or copy-paste from
  -- rich-text sources, which would make audit trails useless.
  CONSTRAINT "product_barcodes_barcode_format"
    CHECK ("barcode" ~ '^[!-~]+$')
);

-- The scan-at-pack path looks up by barcode alone → drive it off
-- the unique index above (no extra index needed).

-- Product-detail page renders barcodes in "primary first" order,
-- so index that shape.
CREATE INDEX "product_barcodes_product_primary_idx"
  ON "product_barcodes" ("product_id", "is_primary" DESC, "created_at" ASC);

-- At most one primary per product. Partial index — only the
-- primary rows are enforced, non-primary rows can freely coexist.
CREATE UNIQUE INDEX "product_barcodes_one_primary_per_product"
  ON "product_barcodes" ("product_id")
  WHERE "is_primary" = TRUE;

COMMIT;
