-- =============================================================================
-- 0010 — products.storage_tier — vendor declares the SKU bucket tier on the
-- product itself, so receiving propagates it to every SKU created from it.
--
-- Until now the SkuService default-ed every new SKU to SMALL because the
-- receiving workflow never had a per-product tier to read. Vendors who
-- ship MEDIUM/LARGE/X_LARGE/PALLET goods saw their inventory page bucketed
-- as SMALL across the board, which broke storage billing accuracy and the
-- downsize-reassessment cron.
--
-- New column is NOT NULL with a SMALL default — existing rows take the
-- default automatically, matching the previous behaviour. Vendors can
-- update each product through the regular edit flow; receiving picks up
-- the per-product tier on the next PSN.
-- =============================================================================

ALTER TABLE products
  ADD COLUMN storage_tier "StorageTier" NOT NULL DEFAULT 'SMALL';

-- Helpful index for any future "products by tier" admin reports.
CREATE INDEX IF NOT EXISTS products_vendor_id_storage_tier_idx
  ON products (vendor_id, storage_tier);
