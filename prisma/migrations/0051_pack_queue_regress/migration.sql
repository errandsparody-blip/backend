-- Migration 0051 — Whitelist the "send back to pack queue" transitions
--   PACKING_COMPLETED            → PENDING_PACKING
--   AWAITING_SHIPPING_SELECTION  → PENDING_PACKING
--   AWAITING_WALLET_FUNDING      → PENDING_PACKING
-- in the order status trigger.
--
-- WHY
--
-- The rate picker (/admin/pack/rates) previously offered an inline
-- "edit pack details" modal that could only correct dimensions /
-- weight / notes — it deliberately could NOT re-open the packaging
-- preset picker, the barcode scan panel, or the carrier template
-- chooser, because doing so would require sending the order all the
-- way back to the full pack flow (/admin/pack), and that is a
-- BACKWARDS status transition the state-machine trigger (migrations
-- 0048 / 0050) rejects with `order_status_backwards` (ERRCODE
-- check_violation / pg 23514).
--
-- Product decision: replace the restrictive inline editor with a
-- proper "Send back to pack queue" action so the operator gets the
-- complete pack toolset again. That requires the order to legally
-- move from any pre-label pack-loop status back to PENDING_PACKING.
--
-- These three edges are the ONLY new sanctioned backwards edges. They
-- join the existing SHIPPING_PAID → AWAITING_SHIPPING_SELECTION
-- compensation edge from migration 0050. Every OTHER backwards
-- transition still raises `order_status_backwards`. SHIPPING_PAID is
-- deliberately NOT allowed to regress here: once the wallet has been
-- debited for shipping, the order is past the pack-edit window
-- (`OrderPackService.sendToPackQueue` guards the same set).
--
-- WHY A WHITELIST (not a session flag)
--
-- Same rationale as migration 0050: a whitelisted edge in the trigger
-- keeps the state-machine invariant fully declarative and greppable
-- for anyone auditing "who allowed this transition?" — rather than
-- pushing trigger-bypass logic into application code via a GUC.
--
-- IDEMPOTENT / REVERSIBLE
--
-- CREATE OR REPLACE FUNCTION — no schema change, no columns added or
-- dropped. Rollback = re-apply migration 0050 verbatim.

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

  -- Compensating transition whitelist (migration 0050). When a Phase-2
  -- label purchase fails after the wallet was already debited, the
  -- caller refunds the wallet and reverts the order status so the
  -- operator can retry with a different rate.
  IF OLD.status = 'SHIPPING_PAID' AND NEW.status = 'AWAITING_SHIPPING_SELECTION' THEN
    RETURN NEW;
  END IF;

  -- "Send back to pack queue" whitelist (migration 0051). Any pre-label
  -- pack-loop status may regress to PENDING_PACKING so the operator can
  -- re-pack with the full toolset (packaging presets, carrier
  -- templates, barcode scan). Guarded application-side by
  -- OrderPackService.sendToPackQueue, which locks the row and refuses
  -- once the label has been bought. SHIPPING_PAID is intentionally
  -- excluded — the wallet is already committed by then.
  IF NEW.status = 'PENDING_PACKING'
     AND OLD.status IN (
       'PACKING_COMPLETED',
       'AWAITING_SHIPPING_SELECTION',
       'AWAITING_WALLET_FUNDING'
     ) THEN
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
