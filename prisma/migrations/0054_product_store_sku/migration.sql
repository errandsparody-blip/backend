-- Migration 0054 — Product store-SKU mapping.
--
-- Lets a vendor link their OWN store SKU (Shopify/Amazon/WooCommerce) to a
-- USA Errands product, so storefront-integration orders can arrive carrying
-- the store's native SKU instead of forcing the merchant to paste our
-- product code into every store listing. The integration line resolver
-- matches an incoming `sku` against store_sku first, then falls back to our
-- `code`.
--
-- Nullable + unique per vendor: a product may have no store SKU (manual /
-- dashboard products), and Postgres treats NULLs as distinct so many rows
-- can stay null. Two products for the same vendor can't claim the same
-- store SKU (ambiguous mapping).
--
-- Additive: one nullable column + one unique index. No backfill.

ALTER TABLE "products" ADD COLUMN "store_sku" VARCHAR(80);

CREATE UNIQUE INDEX "products_vendor_id_store_sku_key"
  ON "products" ("vendor_id", "store_sku");
