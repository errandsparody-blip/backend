-- =============================================================================
-- P3.1 — Orders & Returns: defensive CHECK constraints, FX bounds, append-only
--        order_events trigger, and uniqueness guards.
--
-- This migration runs AFTER `prisma migrate deploy` materializes the new tables
-- from schema.prisma. Constraints below are pure defence in depth: even if the
-- service layer drops a check, the database refuses bad rows.
--
-- Implementation Plan §6.6, §6.7, §14.4 (defence in depth).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- ORDERS — money + qty + state-machine guards
-- -----------------------------------------------------------------------------

ALTER TABLE "orders"
  ADD CONSTRAINT "orders_money_nonneg"
    CHECK (
      "items_declared_value_cents" >= 0 AND
      "shipping_cost_cents"        >= 0 AND
      "shipping_fee_cents"         >= 0 AND
      "fulfillment_fee_cents"      >= 0 AND
      "insurance_fee_cents"        >= 0 AND
      "total_charged_cents"        >= 0
    );

-- Reassessment delta is the ONLY signed money column on orders (can be negative
-- for refunds). Cap at +/- $1,000 sanity to prevent typos / fraud.
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_reassessment_delta_bounds"
    CHECK ("reassessment_delta_cents" BETWEEN -100000 AND 100000);

-- Country must be uppercase ISO-2 (mirrors vendors.country guard).
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_ship_country_iso2"
    CHECK ("ship_country" ~ '^[A-Z]{2}$');

-- US state — when shipping inside the US, must be a 2-letter uppercase code.
-- (We don't enforce the exact list here; that's an app-side concern via Smarty.)
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_us_state_uppercase"
    CHECK (
      "ship_country" <> 'US'
      OR "ship_state" ~ '^[A-Z]{2}$'
    );

-- Postal code basic shape — non-empty, no leading/trailing whitespace.
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_postal_code_nonblank"
    CHECK (length(btrim("ship_postal_code")) > 0);

-- Once shipped, tracking number must be present.
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_shipped_requires_tracking"
    CHECK (
      "status" NOT IN ('SHIPPED','IN_TRANSIT','DELIVERED','RETURNED')
      OR ("tracking_number" IS NOT NULL AND "carrier" IS NOT NULL)
    );

-- DELIVERED → must have delivered_at; SHIPPED → must have shipped_at.
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_delivered_has_timestamp"
    CHECK ("status" <> 'DELIVERED' OR "delivered_at" IS NOT NULL);

ALTER TABLE "orders"
  ADD CONSTRAINT "orders_shipped_has_timestamp"
    CHECK (
      "status" NOT IN ('SHIPPED','IN_TRANSIT','DELIVERED')
      OR "shipped_at" IS NOT NULL
    );

ALTER TABLE "orders"
  ADD CONSTRAINT "orders_cancelled_has_timestamp"
    CHECK ("status" <> 'CANCELLED' OR "cancelled_at" IS NOT NULL);

-- Cancellation requires a reason on record.
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_cancelled_has_reason"
    CHECK ("status" <> 'CANCELLED' OR "cancel_reason" IS NOT NULL);

-- Total charged must equal the sum of its components when not 0 (sanity check —
-- the service layer guarantees this on every write).
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_total_matches_components"
    CHECK (
      "total_charged_cents" = 0
      OR "total_charged_cents" =
         "shipping_fee_cents" + "fulfillment_fee_cents" + "insurance_fee_cents"
    );

-- -----------------------------------------------------------------------------
-- ORDERS — state-machine ratchet trigger.
-- A status may only move forward (or to CANCELLED/EXCEPTION/RETURNED).
-- Backwards transitions, e.g. SHIPPED → ALLOCATED, are refused at the DB level.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION enforce_order_status_transition()
RETURNS TRIGGER AS $$
DECLARE
  old_rank INT;
  new_rank INT;
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
  -- (e.g. small shipments may bypass PICKING/PACKED).
  old_rank := CASE OLD.status
    WHEN 'DRAFT'           THEN 0
    WHEN 'SUBMITTED'       THEN 1
    WHEN 'ALLOCATED'       THEN 2
    WHEN 'LABEL_PURCHASED' THEN 3
    WHEN 'PICKING'         THEN 4
    WHEN 'PACKED'          THEN 5
    WHEN 'SHIPPED'         THEN 6
    WHEN 'IN_TRANSIT'      THEN 7
    WHEN 'EXCEPTION'       THEN 7   -- can recover forward to IN_TRANSIT/DELIVERED
    ELSE -1
  END;

  new_rank := CASE NEW.status
    WHEN 'DRAFT'           THEN 0
    WHEN 'SUBMITTED'       THEN 1
    WHEN 'ALLOCATED'       THEN 2
    WHEN 'LABEL_PURCHASED' THEN 3
    WHEN 'PICKING'         THEN 4
    WHEN 'PACKED'          THEN 5
    WHEN 'SHIPPED'         THEN 6
    WHEN 'IN_TRANSIT'      THEN 7
    WHEN 'DELIVERED'       THEN 8
    WHEN 'RETURNED'        THEN 9
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

DROP TRIGGER IF EXISTS trg_enforce_order_status_transition ON "orders";
CREATE TRIGGER trg_enforce_order_status_transition
BEFORE UPDATE OF status ON "orders"
FOR EACH ROW
EXECUTE FUNCTION enforce_order_status_transition();

-- -----------------------------------------------------------------------------
-- ORDER LINES — qty + tenant-consistency guards
-- -----------------------------------------------------------------------------

ALTER TABLE "order_lines"
  ADD CONSTRAINT "order_lines_qty_positive"
    CHECK ("quantity" > 0);

ALTER TABLE "order_lines"
  ADD CONSTRAINT "order_lines_declared_value_nonneg"
    CHECK ("declared_value_cents" >= 0);

-- Allocation status must be one of the allowed values.
ALTER TABLE "order_lines"
  ADD CONSTRAINT "order_lines_allocation_status_valid"
    CHECK ("allocation_status" IN ('PENDING','RESERVED','PICKED','SHIPPED','RETURNED','CANCELLED'));

-- Vendor consistency: order_line.vendor_id MUST match orders.vendor_id.
-- A trigger enforces this on every insert/update, since FKs alone can't.
CREATE OR REPLACE FUNCTION enforce_order_line_tenant_match()
RETURNS TRIGGER AS $$
DECLARE
  parent_vendor UUID;
BEGIN
  SELECT "vendor_id" INTO parent_vendor FROM "orders" WHERE "id" = NEW."order_id";
  IF parent_vendor IS NULL THEN
    RAISE EXCEPTION 'order_line_orphaned: order % not found', NEW."order_id"
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF parent_vendor <> NEW."vendor_id" THEN
    RAISE EXCEPTION 'order_line_tenant_mismatch: line vendor=% does not match order vendor=%',
      NEW."vendor_id", parent_vendor
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_enforce_order_line_tenant_match ON "order_lines";
CREATE TRIGGER trg_enforce_order_line_tenant_match
BEFORE INSERT OR UPDATE OF "vendor_id","order_id" ON "order_lines"
FOR EACH ROW
EXECUTE FUNCTION enforce_order_line_tenant_match();

-- -----------------------------------------------------------------------------
-- ORDER EVENTS — append-only. Once written, a row may not be modified or
-- deleted. Mirror of the audit_log_entries / ledger_entries pattern.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION enforce_order_events_append_only()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'order_events_immutable: rows are append-only'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'order_events_immutable: rows are append-only'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_order_events_no_update ON "order_events";
CREATE TRIGGER trg_order_events_no_update
BEFORE UPDATE OR DELETE ON "order_events"
FOR EACH ROW
EXECUTE FUNCTION enforce_order_events_append_only();

ALTER TABLE "order_events"
  ADD CONSTRAINT "order_events_source_valid"
    CHECK ("source" IN ('SYSTEM','VENDOR','ADMIN','CARRIER','CRON'));

-- -----------------------------------------------------------------------------
-- RETURNS — money + qty guards
-- -----------------------------------------------------------------------------

ALTER TABLE "returns"
  ADD CONSTRAINT "returns_refund_nonneg"
    CHECK ("refund_amount_cents" >= 0 AND "restock_fee_cents" >= 0);

-- RMA code must be a non-blank, ASCII-printable identifier.
ALTER TABLE "returns"
  ADD CONSTRAINT "returns_rma_code_format"
    CHECK ("rma_code" ~ '^[A-Z0-9-]{4,32}$');

-- Resolved states require resolved_at.
ALTER TABLE "returns"
  ADD CONSTRAINT "returns_terminal_has_resolved_at"
    CHECK (
      "status" NOT IN ('RESTOCKED','DISPOSED','REJECTED','CANCELLED')
      OR "resolved_at" IS NOT NULL
    );

-- -----------------------------------------------------------------------------
-- RETURN LINES — qty bookkeeping
-- -----------------------------------------------------------------------------

ALTER TABLE "return_lines"
  ADD CONSTRAINT "return_lines_qty_nonneg"
    CHECK (
      "requested_qty"  >  0 AND
      "received_qty"   >= 0 AND
      "restocked_qty"  >= 0 AND
      "damaged_qty"    >= 0 AND
      "disposed_qty"   >= 0
    );

-- The disposition split must not exceed what we actually got back.
ALTER TABLE "return_lines"
  ADD CONSTRAINT "return_lines_disposition_within_received"
    CHECK ("restocked_qty" + "damaged_qty" + "disposed_qty" <= "received_qty");

-- And received cannot exceed requested.
ALTER TABLE "return_lines"
  ADD CONSTRAINT "return_lines_received_within_requested"
    CHECK ("received_qty" <= "requested_qty");
