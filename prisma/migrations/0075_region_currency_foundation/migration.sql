-- Migration 0075 — Region + currency foundation (UK expansion, Phase 0).
--
-- Purely additive and backward-compatible: every new column has a default that
-- reproduces today's behaviour (US / USD), so existing rows and existing code
-- are unaffected. Nothing reads these columns yet; later phases wire them in.

-- Fulfilment region enum.
CREATE TYPE "Region" AS ENUM ('US', 'UK');

-- Vendor's fulfilment region. Existing vendors backfilled to US via the default.
ALTER TABLE "vendors"
  ADD COLUMN "region" "Region" NOT NULL DEFAULT 'US';

-- Currency of the money columns (minor units stay in the existing *_cents ints).
-- Defaults to USD so every existing wallet/ledger/order is unchanged.
ALTER TABLE "wallets"
  ADD COLUMN "currency" CHAR(3) NOT NULL DEFAULT 'USD';

ALTER TABLE "ledger_entries"
  ADD COLUMN "currency" CHAR(3) NOT NULL DEFAULT 'USD';

ALTER TABLE "orders"
  ADD COLUMN "currency" CHAR(3) NOT NULL DEFAULT 'USD';
