-- 0075_release_held_order_transition
--
-- Allow a held storefront/integration order to be RELEASED into the
-- fulfilment pipeline.
--
-- Bug: releasing an ON_HOLD order (admin "Release" button, the wallet-deposit
-- hook, the hourly held-order sweep, and the PSN-receive auto-release) re-runs
-- allocation and, on success, UPDATEs the order status ON_HOLD -> PENDING_PACKING.
-- The `enforce_order_status_transition()` trigger has no rank entry for ON_HOLD,
-- so old_rank fell to -1 and the trigger raised
--   `order_status_unknown: ON_HOLD -> PENDING_PACKING`  (SQLSTATE 23514)
-- surfacing to the operator as a 500 "An unexpected error occurred."
--
-- ON_HOLD is only ever reached by INSERT (held orders are created in that
-- state; the trigger fires on UPDATE only), and ON_HOLD -> CANCELLED already
-- works via the side-state whitelist. The only missing edge is the release
-- into the pipeline, added below.
--
-- This re-declares the function verbatim from migration 0053 with a single
-- extra whitelist clause before the rank check. The trigger binding is
-- unchanged (CREATE OR REPLACE keeps it). Reversible: re-apply 0053 to drop
-- the clause.

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

  -- Release-held-order whitelist (migration 0075). A storefront/integration
  -- order parked in ON_HOLD (insufficient funds / stock, unmapped SKU, bad
  -- address) is released into the fulfilment pipeline once the blocker clears.
  -- ON_HOLD has no rank (it is an off-pipeline parking state), so this edge
  -- must be allowed explicitly, before the rank check below. PENDING_PACKING
  -- is the v2 entry point; ALLOCATED is included for any legacy v1 path.
  IF OLD.status = 'ON_HOLD' AND NEW.status IN ('PENDING_PACKING','ALLOCATED') THEN
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
