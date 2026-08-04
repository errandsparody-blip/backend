-- Migration 0050 — Whitelist the compensating transition
--   SHIPPING_PAID → AWAITING_SHIPPING_SELECTION
-- in the order status trigger.
--
-- WHY
--
-- Phase P-C wired the label-purchase step into `selectRate`:
--
--   Phase 1 (tx)   wallet debit + status = SHIPPING_PAID
--   Phase 2 (RPC)  Shippo purchaseLabel
--     success → status = LABEL_PURCHASED
--     failure → refund wallet + revert status = AWAITING_SHIPPING_SELECTION
--
-- The revert is a *compensating* transition: the operator must be able
-- to retry with a different rate after Shippo refuses. But the
-- state-machine trigger from migration 0048 assigns SHIPPING_PAID rank
-- 2.5 and AWAITING_SHIPPING_SELECTION rank 1.7 — that's backwards, so
-- the trigger raises `order_status_backwards` with ERRCODE
-- 'check_violation' (Postgres 23514) and the compensation itself
-- fails, leaving the order stuck in SHIPPING_PAID with the vendor
-- already refunded — the worst possible steady state for a wallet-
-- based system.
--
-- The fix is a targeted CASE branch: if this specific pair is being
-- attempted, allow it. Every OTHER backwards transition remains
-- rejected. The whitelist is a single edge — not a general "backwards
-- allowed" escape hatch — so the state-machine invariant stays
-- meaningful.
--
-- WHY A WHITELIST (not a session flag)
--
-- An alternative is `SET LOCAL app.compensating = 'true'` in the
-- compensation SQL, with the trigger reading the GUC. That works but:
--   * it puts trigger-bypass logic in application code (any caller
--     that sets the flag defeats the trigger — an audit surface)
--   * it requires the trigger to know about the GUC namespace
--   * it's harder to grep for from ops ("who allowed this transition?")
-- A whitelisted edge in the trigger itself keeps the state-machine
-- invariant fully declarative.
--
-- IDEMPOTENT / REVERSIBLE
--
-- CREATE OR REPLACE FUNCTION — no schema change. Migration 0048 can be
-- re-applied without conflict. No columns added or dropped. Rollback
-- = re-apply migration 0048 verbatim.

BEGIN;

CREATE OR REPLACE FUNCTION enforce_order_status_transition()
RETURNS TRIGGER AS $$
DECLARE
  old_rank NUMERIC;
  new_rank NUMERIC;
BEGIN
  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  -- Terminal states — once here, only allow self (handled above).
  IF OLD.status IN ('DELIVERED','CANCELLED','RETURNED') THEN
    RAISE EXCEPTION 'order_status_terminal: cannot transition from % to %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  -- Side states — CANCELLED / EXCEPTION can be reached from any non-terminal,
  -- and RETURNED can be reached from DELIVERED only (already excluded above:
  -- DELIVERED is terminal for forward flow; RETURNED is set by the returns
  -- workflow which must update directly through a privileged path).
  IF NEW.status IN ('CANCELLED','EXCEPTION') THEN
    RETURN NEW;
  END IF;

  -- Compensating transition whitelist. When a Phase-2 label purchase
  -- fails after the wallet was already debited, the caller refunds the
  -- wallet and reverts the order status so the operator can retry with
  -- a different rate. This is the ONLY sanctioned backwards edge — every
  -- other backwards transition still raises `order_status_backwards`.
  --
  -- Kept as an explicit IF branch (not a data-driven table) so the
  -- allow-list is visible at the top of the trigger for anyone
  -- auditing the state machine.
  IF OLD.status = 'SHIPPING_PAID' AND NEW.status = 'AWAITING_SHIPPING_SELECTION' THEN
    RETURN NEW;
  END IF;

  -- Forward path ranks. Any forward step is allowed; skipping is allowed
  -- (e.g. small shipments may bypass PICKING/PACKED). NUMERIC (not INT)
  -- so v2 statuses can use fractional ranks that slot between legacy
  -- ranks without renumbering the legacy ladder.
  --
  -- Legacy ladder (unchanged from migration 0006):
  --   DRAFT           0
  --   SUBMITTED       1
  --   ALLOCATED       2
  --   LABEL_PURCHASED 3
  --   PICKING         4
  --   PACKED          5
  --   SHIPPED         6
  --   IN_TRANSIT      7
  --   HANDED_OFF      7.5  (migration 0037 terminal for VENDOR_CARRIER)
  --   DELIVERED       8
  --   RETURNED        9
  --   EXCEPTION       7    (can recover forward to IN_TRANSIT/DELIVERED)
  --
  -- v2 pack-step ladder (migration 0041, wired in migration 0048):
  --   PENDING_PACKING              1.5
  --   PACKING_COMPLETED            1.6
  --   AWAITING_WALLET_FUNDING      1.65
  --   AWAITING_SHIPPING_SELECTION  1.7
  --   SHIPPING_PAID                2.5
  old_rank := CASE OLD.status
    WHEN 'DRAFT'                       THEN 0
    WHEN 'SUBMITTED'                   THEN 1
    WHEN 'PENDING_PACKING'             THEN 1.5
    WHEN 'PACKING_COMPLETED'           THEN 1.6
    WHEN 'AWAITING_WALLET_FUNDING'     THEN 1.65
    WHEN 'AWAITING_SHIPPING_SELECTION' THEN 1.7
    WHEN 'ALLOCATED'                   THEN 2
    WHEN 'SHIPPING_PAID'               THEN 2.5
    WHEN 'LABEL_PURCHASED'             THEN 3
    WHEN 'PICKING'                     THEN 4
    WHEN 'PACKED'                      THEN 5
    WHEN 'SHIPPED'                     THEN 6
    WHEN 'IN_TRANSIT'                  THEN 7
    WHEN 'HANDED_OFF'                  THEN 7.5
    WHEN 'EXCEPTION'                   THEN 7
    ELSE -1
  END;

  new_rank := CASE NEW.status
    WHEN 'DRAFT'                       THEN 0
    WHEN 'SUBMITTED'                   THEN 1
    WHEN 'PENDING_PACKING'             THEN 1.5
    WHEN 'PACKING_COMPLETED'           THEN 1.6
    WHEN 'AWAITING_WALLET_FUNDING'     THEN 1.65
    WHEN 'AWAITING_SHIPPING_SELECTION' THEN 1.7
    WHEN 'ALLOCATED'                   THEN 2
    WHEN 'SHIPPING_PAID'               THEN 2.5
    WHEN 'LABEL_PURCHASED'             THEN 3
    WHEN 'PICKING'                     THEN 4
    WHEN 'PACKED'                      THEN 5
    WHEN 'SHIPPED'                     THEN 6
    WHEN 'IN_TRANSIT'                  THEN 7
    WHEN 'HANDED_OFF'                  THEN 7.5
    WHEN 'DELIVERED'                   THEN 8
    WHEN 'RETURNED'                    THEN 9
    ELSE -1
  END;

  IF old_rank < 0 OR new_rank < 0 THEN
    RAISE EXCEPTION 'order_status_unknown: % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  IF new_rank < old_rank THEN
    RAISE EXCEPTION 'order_status_backwards: cannot go from % (rank %) to % (rank %)',
      OLD.status, old_rank, NEW.status, new_rank
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMIT;
