/**
 * Page permissions — canonical page-key registry for the ADMIN role.
 *
 * Introduced by migration 0039. The registry lives here (backend) and
 * is mirrored verbatim on the web at:
 *   usa-errands-web/src/lib/schemas/page-permissions.ts
 * Both files must stay in sync — the string values are the shared
 * contract that the config row, the guard, the sidebar, and every
 * `@RequiresPage(...)` decorator all speak.
 *
 * Design choices worth defending:
 *
 *   1. Deny-by-default. `ADMIN_DEFAULT_PERMISSIONS` lists the keys an
 *      ADMIN can access when the config row is absent OR when a newly
 *      added key hasn't been explicitly set. Any page key that
 *      doesn't appear in either the config row or the defaults is
 *      DENIED. Adding a new admin page later never accidentally grants
 *      it to ADMIN.
 *
 *   2. Resource + verb naming (`admin.<resource>.<verb>`). Read-only
 *      access to a page is a different key from mutating it — an
 *      ADMIN with `admin.vendors.read` can see the vendor detail page
 *      but can't hit the KYC approve/reject endpoints (those require
 *      `admin.vendors.write` OR a SUPER_ADMIN role).
 *
 *   3. SUPER_ADMIN NEVER goes through the page-permission check.
 *      They're gated by @Roles(Role.SUPER_ADMIN) at the controller
 *      level; the page-permission guard short-circuits to allow for
 *      that role. This is what prevents an errant config row from
 *      locking the platform owner out of their own admin.
 *
 *   4. `admin.config.*` and every approve/reject action are
 *      intentionally NOT in this registry. Those endpoints are
 *      role-gated to SUPER_ADMIN only; there is no config knob that
 *      can grant ADMIN access to them. This closes the "SUPER_ADMIN
 *      gives an ADMIN a permission that lets them grant themselves
 *      more permissions" privilege-escalation loop.
 */

/**
 * Every page key the ADMIN role can be granted. The `as const` +
 * derived union make this a compile-time exhaustive list — TypeScript
 * refuses a `RequiresPage("admin.does-not-exist")` at build time.
 */
export const PAGE_KEYS = [
  // Landing card. Cheap to allow; every admin lands somewhere.
  "admin.dashboard",

  // Vendors.
  "admin.vendors.read",

  // Orders. Reading the queue vs. running transitions (pick / pack /
  // ship / mark handed-off) are two different keys.
  "admin.orders.read",
  "admin.orders.write",

  // Pre-shipment notices (inbound). Reading the queue vs. actually
  // receiving stock.
  "admin.psn.read",
  "admin.psn.write",

  // Inventory (SKU-level).
  "admin.inventory.read",

  // Returns queue + individual RMA inspection.
  "admin.returns.read",
  "admin.returns.write",

  // Shopper — the "shop for me" pipeline. Config is a separate key
  // because it edits money-affecting knobs (tax rates, ID threshold,
  // payment methods) and is closer to admin.config in blast radius
  // than to admin.shopper.write.
  "admin.shopper.read",
  "admin.shopper.write",

  // Wallet finance — reading vs. crediting/refunding.
  "admin.finance.read",

  // Ops notifications inbox.
  "admin.notifications.read",

  // Audit log — read-only by design; nothing ever mutates it.
  "admin.audit.read",
] as const;

export type PageKey = (typeof PAGE_KEYS)[number];

/**
 * Set-membership helper. Narrows an arbitrary string down to `PageKey`
 * at compile time when true. Used by the config-row loader to filter
 * out unknown keys (which can appear if we ever remove a key from the
 * registry without cleaning the config row first).
 */
export function isPageKey(value: unknown): value is PageKey {
  return typeof value === "string" && (PAGE_KEYS as readonly string[]).includes(value);
}

/**
 * Permissions granted to a fresh ADMIN user when the config row is
 * absent OR when a specific key hasn't been explicitly set to `true`
 * yet. Deliberately small — the whole point of the ADMIN role is
 * least privilege.
 */
export const ADMIN_DEFAULT_PERMISSIONS: readonly PageKey[] = [
  "admin.dashboard",
  "admin.vendors.read",
  "admin.shopper.read",
  "admin.shopper.write",
];

/**
 * Configuration table key that stores the ADMIN role's page-permission
 * overrides. The value shape is `{ [pageKey: string]: boolean }`.
 * Missing keys fall back to `ADMIN_DEFAULT_PERMISSIONS`.
 */
export const ADMIN_ROLE_PERMISSIONS_CONFIG_KEY = "admin_role_page_permissions";
