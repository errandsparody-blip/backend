-- Migration 0053 — Allow the returns workflow to move an order to
-- RETURNED from DELIVERED (or HANDED_OFF).
--
-- WHY
--
-- ReturnService.finalize (and the legacy inspect path) flips the parent
-- order to RETURNED once a return is resolved. But the order status
-- trigger treats DELIVERED as TERMINAL and raises `order_status_terminal`
-- for ANY transition out of it — including DELIVERED → RETURNED. So
-- finalizing a return on a platform-ship (delivered) order fails with a
-- check_violation, surfacing as a 500. The trigger's own comment says
-- "RETURNED is set by the returns workflow which must update directly
-- through a privileged path", but no such edge was ever whitelisted.
--
-- HANDED_OFF → RETURNED already works (HANDED_OFF isn't terminal and
-- ranks below RETURNED), but we whitelist it here too so the returns
-- edge is declared in one obvious place.
--
-- FIX
--
-- Whitelist `NEW.status = 'RETURNED' AND OLD.status IN
-- ('DELIVERED','HANDED_OFF')` BEFORE the terminal guard. Every other
-- transition out of a terminal state stays blocked. Application code
-- (ReturnService) is the authority on WHEN this runs — a return must be
-- finalized (or a legal/safety disposal) for the order to reach RETURNED.
--
-- IDEMPOTENT / REVERSIBLE
--
-- CREATE OR REPLACE FUNCTION — no schema change. Rollback = re-apply
-- migration 0051 verbatim.

CREATE OR REPLACE FUNCTION enforce_order_status_transition()
RETURNS TRIGGER AS $$
DECLARE
  old_rank NUMERIC;
  new_rank NUMERIC;
BEGIN
  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  -- Returns workflow whitelist (migration 0053). A resolved return moves
  -- its order to RETURNED. DELIVERED is otherwise terminal, so this edge
  -- must be allowed BEFORE the terminal guard below. HANDED_OFF is
  -- included for clarity (it would pass the rank check anyway).
  IF NEW.status = 'RETURNED' AND OLD.status IN ('DELIVERED','HANDED_OFF') THEN
    RETURN NEW;
  END IF;

  -- Terminal states — once here, only allow self (handled above).
  IF OLD.status IN ('DELIVERED','CANCELLED','RETURNED') THEN
    RAISE EXCEPTION 'order_status_terminal: cannot transition from % to %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  -- Side states — CANCELLED / EXCEPTION can be reached from any non-terminal.
  IF NEW.status IN ('CANCELLED','EXCEPTION') THEN
    RETURN NEW;
  END IF;

  -- Compensating transition whitelist (migration 0050).
  IF OLD.status = 'SHIPPING_PAID' AND NEW.status = 'AWAITING_SHIPPING_SELECTION' THEN
    RETURN NEW;
  END IF;

  -- "Send back to pack queue" whitelist (migration 0051).
  IF NEW.status = 'PENDING_PACKING'
     AND OLD.status IN (
       'PACKING_COMPLETED',
       'AWAITING_SHIPPING_SELECTION',
       'AWAITING_WALLET_FUNDING'
     ) THEN
    RETURN NEW;
  END IF;

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
