-- 0079_ledger_country
--
-- USA + Canada (Phase 9). Tags wallet ledger entries with the country they
-- belong to (US / CA) so a vendor can filter their statement per country.
-- Nullable: country-neutral entries (deposits, top-ups, referral bonuses) stay
-- NULL. Additive; existing rows are unaffected.

ALTER TABLE "ledger_entries" ADD COLUMN "country" CHAR(2);

CREATE INDEX "ledger_entries_vendor_id_country_created_at_idx"
  ON "ledger_entries" ("vendor_id", "country", "created_at");
