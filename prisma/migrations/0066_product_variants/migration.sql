-- Migration 0066 — marketplace product variants (size × colour) + image gallery.
-- A storefront listing can offer several variants. Each variant stays its OWN
-- product row (its own stock/SKUs, price, images), so receiving, packing, and
-- checkout are unchanged; variant_group_id just links the rows into one listing.
-- option_size / option_color are the selectable axes; image_urls is the
-- per-variant gallery (image_url remains the primary/first). All NULL / empty
-- for existing products — additive, no backfill, idempotent.

ALTER TABLE "products"
  ADD COLUMN IF NOT EXISTS "variant_group_id" UUID,
  ADD COLUMN IF NOT EXISTS "option_size" TEXT,
  ADD COLUMN IF NOT EXISTS "option_color" TEXT,
  ADD COLUMN IF NOT EXISTS "image_urls" TEXT[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS "products_variant_group_idx"
  ON "products" ("variant_group_id");
