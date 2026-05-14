/**
 * Human-readable order references.
 *
 * Every Order row has a monotonic integer `orderNumber` populated by the
 * Postgres sequence `orders_order_number_seq` (migration 0029). The user
 * never sees the raw integer — emails, notifications, the receipt, and
 * the portal UI all render it through `formatOrderRef` so the format is
 * defined in exactly one place. If we ever want to widen the prefix or
 * pad the digits (`#001625` for instance) this is the only file that
 * needs to change.
 */

/**
 * Render a stored `orderNumber` as the visitor-facing reference, e.g.
 * `formatOrderRef(1625) === "#1625"`. The leading `#` is part of the
 * display contract — callers should NOT add another one.
 */
export function formatOrderRef(orderNumber: number): string {
  // Guard against accidental nulls leaking in via partial selects. Better
  // to render "#?" than crash a transactional email send.
  if (!Number.isFinite(orderNumber)) return "#?";
  return `#${Math.trunc(orderNumber)}`;
}
