-- 0085_free_cancelled_external_refs
--
-- A cancelled order used to keep "owning" its external_reference, so a vendor
-- who cancelled an order and tried to re-create it hit
-- `order_external_ref_duplicate` (409). Going forward the cancel paths NULL the
-- reference; this backfill frees it on orders that were already cancelled, and
-- preserves the old value in the cancel note so it's still visible.
--
-- Safe: only touches CANCELLED rows, and NULLs don't collide in the
-- (vendor_id, external_reference) unique index.

UPDATE orders
SET
  cancel_note = COALESCE(cancel_note, '') || ' [ref: ' || external_reference || ']',
  external_reference = NULL
WHERE status = 'CANCELLED'
  AND external_reference IS NOT NULL;
