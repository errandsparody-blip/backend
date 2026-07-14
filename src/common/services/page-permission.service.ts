/**
 * PagePermissionService — resolves which admin pages an authenticated
 * user is allowed to touch.
 *
 * Introduced by migration 0039. Called by:
 *   * PagePermissionGuard (per-request RBAC gate);
 *   * GET /v1/auth/me/page-permissions (frontend sidebar hydration);
 *   * GET /v1/admin/config/admin-role-permissions (admin config UI).
 *
 * Resolution rules (in order):
 *   1. SUPER_ADMIN → all pages allowed. Compiled bypass; no config row
 *      can lock the platform owner out.
 *   2. ADMIN → intersect the config row with the canonical page-key
 *      list, fall back to ADMIN_DEFAULT_PERMISSIONS for keys not
 *      explicitly set. Deny-by-default: absence == false.
 *   3. Every other role → this service returns an empty set. The
 *      existing @Roles(...) decorator is what actually authorises
 *      those roles; this service does NOT re-decide what a
 *      WAREHOUSE_OPERATOR can do.
 *
 * Caching: the config row is read at most once every 30 seconds per
 * API process. A cache miss on a hot path adds one Postgres round-
 * trip; hits are in-memory. The TTL is short enough that a
 * SUPER_ADMIN toggling a permission sees it apply "within 30
 * seconds" without needing an explicit invalidation from the
 * PATCH endpoint. If we ever need faster propagation we can bust
 * the cache from the mutator; today the tradeoff isn't worth it.
 */

import { Injectable, Logger } from "@nestjs/common";
import { Role } from "@prisma/client";

import { PrismaService } from "../prisma.service";

// Migration 0039 — the ADMIN enum member is added by this migration.
// Compared against the generated Prisma type as a string constant so
// the reference builds cleanly whether or not the local Prisma client
// has been regenerated (Railway regenerates on deploy; local
// sandboxes may lag). Prisma enums are string-valued at runtime, so
// the equality check is exact.
const ROLE_ADMIN = "ADMIN" as Role;
import {
  ADMIN_DEFAULT_PERMISSIONS,
  ADMIN_ROLE_PERMISSIONS_CONFIG_KEY,
  isPageKey,
  PAGE_KEYS,
  type PageKey,
} from "../schemas/page-permissions";

interface AuthLike {
  role: Role;
}

/**
 * Full page-permission map: every canonical key mapped to a boolean.
 * The service always returns the exhaustive map so callers don't have
 * to worry about missing keys (the sidebar, in particular, iterates
 * this map to decide which nav items to hide).
 */
export type PagePermissionMap = Readonly<Record<PageKey, boolean>>;

@Injectable()
export class PagePermissionService {
  private readonly logger = new Logger(PagePermissionService.name);
  private cache: {
    fetchedAt: number;
    adminOverrides: Partial<Record<PageKey, boolean>>;
  } | null = null;
  private readonly CACHE_TTL_MS = 30_000;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * True if the user is allowed to hit the endpoint requiring the
   * given page key. This is the single decision function; the guard
   * calls it once per request.
   */
  async canAccess(user: AuthLike, pageKey: PageKey): Promise<boolean> {
    // SUPER_ADMIN never gates. A config row must never lock the
    // platform owner out.
    if (user.role === Role.SUPER_ADMIN) return true;
    // Non-ADMIN roles pass THIS check unconditionally — they are
    // authorized (or not) by the @Roles(...) decorator alone.
    // @RequiresPage is an ADDITIONAL, ADMIN-only gate; for every
    // other role it's a no-op. Returning false here would break the
    // existing WAREHOUSE_OPERATOR / FINANCE_ADMIN paths on any
    // endpoint that grows a @RequiresPage decorator.
    if (user.role !== ROLE_ADMIN) return true;
    const overrides = await this.loadAdminOverrides();
    return this.resolveAdminKey(pageKey, overrides);
  }

  /**
   * The full effective permission map for the given user. Used by
   * the sidebar hydration endpoint so the frontend can hide items
   * in one round-trip. Deny-by-default for non-admin roles keeps
   * accidental leaks out of the response shape.
   */
  async getEffectivePermissions(user: AuthLike): Promise<PagePermissionMap> {
    // Admin roles that pre-date migration 0039 (WAREHOUSE_OPERATOR /
    // FINANCE_ADMIN / SUPER_ADMIN) get the exhaustive true map. The
    // sidebar is UX polish for them — the real gate is the @Roles
    // decorator at the controller level. Historically they saw every
    // admin sidebar item; migration 0039 must not change that.
    const isAdminRole =
      user.role === Role.SUPER_ADMIN ||
      user.role === Role.FINANCE_ADMIN ||
      user.role === Role.WAREHOUSE_OPERATOR;
    if (isAdminRole) {
      // Object.fromEntries is O(n) over the frozen list; n is small.
      return Object.freeze(
        Object.fromEntries(PAGE_KEYS.map((k) => [k, true])) as Record<PageKey, boolean>,
      );
    }
    if (user.role !== ROLE_ADMIN) {
      // Vendors (and any future non-admin role) hit this branch.
      // They don't use the admin sidebar; returning all-false keeps
      // the response shape honest and prevents an accidental leak.
      return Object.freeze(
        Object.fromEntries(PAGE_KEYS.map((k) => [k, false])) as Record<PageKey, boolean>,
      );
    }
    const overrides = await this.loadAdminOverrides();
    return Object.freeze(
      Object.fromEntries(
        PAGE_KEYS.map((k) => [k, this.resolveAdminKey(k, overrides)]),
      ) as Record<PageKey, boolean>,
    );
  }

  /**
   * Read the admin overrides map DIRECTLY (skipping the cache).
   * Used by the GET config endpoint so an admin editing the toggle
   * matrix always sees the freshly-persisted state, not a 30s-old
   * cache. Not exposed to per-request guard traffic — that stays on
   * the cached path.
   */
  async readAdminOverridesFresh(): Promise<Partial<Record<PageKey, boolean>>> {
    const overrides = await this.fetchAdminOverridesFromDb();
    // Also refresh the in-memory cache so subsequent guard checks
    // see the same value without another DB round-trip.
    this.cache = { fetchedAt: Date.now(), adminOverrides: overrides };
    return overrides;
  }

  /**
   * Persist a full override map. Only SUPER_ADMIN reaches this path
   * (enforced at the controller layer); we still filter to the
   * canonical PAGE_KEYS to defend against a request smuggling an
   * unknown key into the JSON blob.
   */
  async writeAdminOverrides(next: Partial<Record<string, boolean>>): Promise<
    Partial<Record<PageKey, boolean>>
  > {
    const clean: Partial<Record<PageKey, boolean>> = {};
    for (const [k, v] of Object.entries(next)) {
      if (isPageKey(k) && typeof v === "boolean") clean[k] = v;
    }
    await this.prisma.configuration.upsert({
      where: { key: ADMIN_ROLE_PERMISSIONS_CONFIG_KEY },
      create: { key: ADMIN_ROLE_PERMISSIONS_CONFIG_KEY, value: clean },
      update: { value: clean },
    });
    // Bust the cache so a SUPER_ADMIN doesn't see stale UI right
    // after clicking Save. Guard checks refetch on next call.
    this.cache = { fetchedAt: Date.now(), adminOverrides: clean };
    return clean;
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private resolveAdminKey(
    pageKey: PageKey,
    overrides: Partial<Record<PageKey, boolean>>,
  ): boolean {
    // Explicit true/false in the config wins. Absence falls back to
    // the compiled-in default set — never `true` for a key the
    // SUPER_ADMIN hasn't seen (deny-by-default).
    const explicit = overrides[pageKey];
    if (typeof explicit === "boolean") return explicit;
    return (ADMIN_DEFAULT_PERMISSIONS as readonly PageKey[]).includes(pageKey);
  }

  private async loadAdminOverrides(): Promise<Partial<Record<PageKey, boolean>>> {
    const now = Date.now();
    if (this.cache && now - this.cache.fetchedAt < this.CACHE_TTL_MS) {
      return this.cache.adminOverrides;
    }
    const fresh = await this.fetchAdminOverridesFromDb();
    this.cache = { fetchedAt: now, adminOverrides: fresh };
    return fresh;
  }

  private async fetchAdminOverridesFromDb(): Promise<Partial<Record<PageKey, boolean>>> {
    try {
      const row = await this.prisma.configuration.findUnique({
        where: { key: ADMIN_ROLE_PERMISSIONS_CONFIG_KEY },
      });
      if (!row) return {};
      const value = row.value as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        this.logger.warn(
          { value },
          "admin_role_page_permissions row is not an object; ignoring",
        );
        return {};
      }
      const out: Partial<Record<PageKey, boolean>> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        // Filter to canonical keys — a stale key that used to exist
        // but has since been removed from the registry is ignored,
        // never confused for a new key.
        if (isPageKey(k) && typeof v === "boolean") out[k] = v;
      }
      return out;
    } catch (err) {
      // A DB failure here would 500 every admin request. Better to
      // log and fall back to the compiled defaults — an ADMIN with
      // the minimum viable page set is a better degraded mode than
      // a totally broken admin console.
      this.logger.error({ err }, "page-permission config load failed; falling back to defaults");
      return {};
    }
  }
}
