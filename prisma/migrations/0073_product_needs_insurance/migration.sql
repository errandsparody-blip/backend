-- Migration 0073 — per-product "needs insurance" flag.
--
-- The admin dashboard's Insurable Inventory Value counts every unit
-- physically in our care. Not every product actually needs insurance
-- coverage (low-value filler, samples, etc.), so admins want to exclude
-- those from the coverage figure. This column lets an admin mark a
-- product as not-insurable; the dashboard can then filter to insurable
-- products only.
--
-- Defaults to TRUE so nothing is silently dropped from the coverage
-- number on rollout — admins opt products OUT, never accidentally
-- under-insure by omission.
ALTER TABLE products
  ADD COLUMN needs_insurance BOOLEAN NOT NULL DEFAULT true;
