-- 0069 · Vendor-declared returns policy.
--
-- Each vendor storefront declares whether it accepts returns and, if so, how
-- many days after the order ships a buyer may request one. Buyer return
-- requests (storefront_return_requests) are gated on these at request time.
--
-- Defaults preserve today's behaviour: returns allowed, 30-day window.

ALTER TABLE "vendor_storefronts"
  ADD COLUMN IF NOT EXISTS "returns_allowed" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "return_window_days" INTEGER NOT NULL DEFAULT 30;
