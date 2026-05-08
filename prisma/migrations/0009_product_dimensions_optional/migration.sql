-- =============================================================================
-- 0009 — products: length / width / height become OPTIONAL.
--
-- Rationale: many vendors (apparel, accessories) ship items where the box
-- dimensions are determined at pack time, not at the product level. Forcing
-- them to type three placeholder numbers at product creation gates the
-- whole onboarding flow on data the warehouse will collect later anyway.
--
-- Wire impact:
--   - lengthIn / widthIn / heightIn become nullable. Existing rows are
--     untouched.
--   - The order-fees envelope calc treats null as 0 for that line, so a
--     vendor with no dims still gets a quote (carrier rates from weight
--     alone, less precise). When dims are provided they're respected.
-- =============================================================================

ALTER TABLE products ALTER COLUMN length_in DROP NOT NULL;
ALTER TABLE products ALTER COLUMN width_in  DROP NOT NULL;
ALTER TABLE products ALTER COLUMN height_in DROP NOT NULL;
