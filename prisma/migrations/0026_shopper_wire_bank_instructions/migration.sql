-- Migration 0026 — per-request wire bank instructions.
--
-- Until now the bank account for every wire-transfer request came from a
-- single global config row (`shopper_bank_instructions`). The product team
-- decided the admin should be able to pick a specific account per request
-- when approving the buyer's ID — the chosen account number then appears
-- in the approval email and on the buyer's thread page.
--
-- We persist it as a JSONB column on the request itself so the historical
-- record always pairs each request with the exact account the buyer was
-- told to wire to. When `wire_bank_instructions` is NULL, the
-- buyer-facing endpoints fall back to the global config — so existing
-- requests created before this migration keep working unchanged.
--
-- Shape: { beneficiaryName?, bankName?, accountNumber, routingNumber?,
--          swift?, iban?, memo? } — matches the global config row so the
-- frontend can render both the same way.

ALTER TABLE "shopper_requests"
  ADD COLUMN IF NOT EXISTS "wire_bank_instructions" JSONB;
