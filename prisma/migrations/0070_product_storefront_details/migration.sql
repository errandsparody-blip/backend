-- 0070 · Vendor-authored storefront product details (ASOS-style).
--
-- Rich, buyer-facing detail fields a vendor fills in to describe a listing:
-- a free-text description plus structured attributes (fit, gender, material,
-- care, brand, ships-from). All optional and nullable — existing products keep
-- working with everything null. Size is NOT stored here: it comes from the
-- product's own `variant` (its inventory listing), never re-typed.

ALTER TABLE "products"
  ADD COLUMN IF NOT EXISTS "description"        TEXT,
  ADD COLUMN IF NOT EXISTS "fit"                VARCHAR(60),
  ADD COLUMN IF NOT EXISTS "gender"             VARCHAR(30),
  ADD COLUMN IF NOT EXISTS "material"           VARCHAR(120),
  ADD COLUMN IF NOT EXISTS "care_instructions"  VARCHAR(300),
  ADD COLUMN IF NOT EXISTS "brand"              VARCHAR(80);
