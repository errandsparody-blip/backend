-- =============================================================================
-- P2 — defense-in-depth constraints + append-only enforcement on ledger_entries.
-- Implementation Plan §6.4, §4.7 (audit immutability pattern).
-- =============================================================================

-- 1) Wallet balance never goes negative — even if application logic is bypassed.
ALTER TABLE wallets
  ADD CONSTRAINT wallets_balance_nonneg CHECK (balance_cents >= 0),
  ADD CONSTRAINT wallets_low_balance_threshold_nonneg CHECK (low_balance_threshold_cents >= 0);

-- 2) Ledger entries are append-only.
CREATE OR REPLACE FUNCTION ledger_no_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entries is append-only; UPDATE is forbidden';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ledger_no_update ON ledger_entries;
CREATE TRIGGER trg_ledger_no_update
BEFORE UPDATE ON ledger_entries
FOR EACH ROW EXECUTE FUNCTION ledger_no_update();

CREATE OR REPLACE FUNCTION ledger_no_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entries is append-only; DELETE is forbidden';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ledger_no_delete ON ledger_entries;
CREATE TRIGGER trg_ledger_no_delete
BEFORE DELETE ON ledger_entries
FOR EACH ROW EXECUTE FUNCTION ledger_no_delete();

-- 3) Optional: revoke UPDATE / DELETE on ledger_entries from the application
-- role at the privilege level (run as superuser in prod).
-- REVOKE UPDATE, DELETE, TRUNCATE ON ledger_entries FROM usaerrands_app;

-- 4) Sign-consistency CHECK: deposit-class types must be positive; charge-class
-- types must be negative. Reversal can be either sign. Documented invariant.
ALTER TABLE ledger_entries
  ADD CONSTRAINT ledger_sign_invariant CHECK (
    (type = 'DEPOSIT'        AND amount_cents > 0) OR
    (type = 'MANUAL_CREDIT'  AND amount_cents > 0) OR
    (type = 'ONBOARDING'     AND amount_cents < 0) OR
    (type = 'STORAGE'        AND amount_cents < 0) OR
    (type = 'FULFILLMENT'    AND amount_cents < 0) OR
    (type = 'SHIPPING'       AND amount_cents < 0) OR
    (type = 'RETURN'         AND amount_cents < 0) OR
    (type = 'MANUAL_DEBIT'   AND amount_cents < 0) OR
    (type = 'REVERSAL')
  );
