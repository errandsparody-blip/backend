-- Migration 0048 — Teach the order status-transition trigger about
-- the Fulfillment v2 lifecycle statuses (added by migration 0041).
--
-- The pre-existing trigger `enforce_order_status_transition` (migration
-- 0006) uses a hardcoded CASE with legacy statuses only. When Phase C
-- shipped, `OrderPackService.recordPack` started transitioning
-- PENDING_PACKING → PACKING_COMPLETED. The trigger's CASE returned
-- rank -1 for both, hit the `old_rank < 0 OR new_rank < 0` branch, and
-- raised with ERRCODE = 'check_violation' (Postgres SQLSTATE 23514).
--
-- That's the "pg=23514" the ops log surfaced. It looks like a CHECK
-- constraint failure but it's actually a trigger's RAISE EXCEPTION.
--
-- FIX: CREATE OR REPLACE the function so the CASE knows every current
-- OrderStatus enum value. Ranks are assigned so that:
--
--   * The legacy path (DRAFT → SUBMITTED → ALLOCATED → LABEL_PURCHASED
--     → PICKING → PACKED → SHIPPED → IN_TRANSIT → DELIVERED / RETURNED)
--     keeps its original 0..9 ranking. Existing legacy in-flight orders
--     (workflowVersion=1) continue to transition exactly as before.
--
--   * The v2 path (PENDING_PACKING → PACKING_COMPLETED →
--     AWAITING_SHIPPING_SELECTION → AWAITING_WALLET_FUNDING →
--     SHIPPING_PAID → LABEL_PURCHASED → PICKING → PACKED → SHIPPED
--     → IN_TRANSIT → DELIVERED / RETURNED) uses ranks 1.5..2.5 for
--     the pack-step statuses (they slot between SUBMITTED at rank 1
--     and ALLOCATED at rank 2), so a v2 order can advance forward
--     through the pack loop, then converge with the legacy path at
--     LABEL_PURCHASED (rank 3).
--
--   * AWAITING_WALLET_FUNDING deliberately ranks LOWER than
--     AWAITING_SHIPPING_SELECTION so a "wallet short → vendor tops up
--     → re-select rate" flow doesn't count as a backwards transition.
--     Same for AWAITING_SHIPPING_SELECTION being reachable again
--     from PACKING_COMPLETED via a re-fetch. See OrderPackService.
--
-- HANDEDOFF (from migration 0037, VENDOR_CARRIER terminal): gets a
-- rank between SHIPPED and DELIVERED so a VENDOR_CARRIER order that
-- ended in HANDED_OFF can't be nudged backwards or into a status
-- that assumes a platform label was bought.
--
-- Terminal statuses (DELIVERED, CANCELLED, RETURNED) keep the same
-- guard from 0006 — once here, only self-transitions are allowed.

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
  -- v2 pack-step ladder (migration 0041, wired here):
  --   PENDING_PACKING              1.5
  --   PACKING_COMPLETED            1.6
  --   AWAITING_SHIPPING_SELECTION  1.7
  --   AWAITING_WALLET_FUNDING      1.65 (below AWAITING_SHIPPING_SELECTION
  --                                      so re-fetch-rates after top-up
  --                                      counts as forward, not backward)
  --   SHIPPING_PAID                2.5  (between ALLOCATED (2) and
  --                                      LABEL_PURCHASED (3) — v2 orders
  --                                      converge with legacy here)
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
