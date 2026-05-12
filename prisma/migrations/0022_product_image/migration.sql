-- Migration 0022 — product image URL.
--
-- Adds an optional image field to `products` so vendors can attach a
-- visual representation of each product. The URL points at our R2 bucket
-- (uploaded via a presigned PUT, same flow as shopper attachments and
-- return RMA evidence). Storing the URL — not the bytes — keeps the
-- products table small and lets us swap CDNs later without a data
-- migration.
--
-- Forward-only. No backfill needed (column is nullable).

ALTER TABLE "products"
  ADD COLUMN "image_url" TEXT;

-- The URL gets validated at the application layer (Zod, max 2048 chars,
-- http(s) only). We intentionally don't add a DB CHECK constraint —
-- application-level validation is sufficient and a CHECK here would
-- complicate future CDN migrations.
