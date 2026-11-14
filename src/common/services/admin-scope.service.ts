/**
 * AdminScopeService — USA + Canada operational scoping (migration 0078).
 *
 * Operational ADMINs only see the vendors assigned to them, and only for their
 * own country. This service resolves, for a given admin user, which vendors and
 * which country they may act on, and hands callers a ready-made Prisma filter.
 *
 * Resolution:
 *   * SUPER_ADMIN (and the legacy WAREHOUSE_OPERATOR / FINANCE_ADMIN roles,
 *     which have always seen everything) → UNRESTRICTED. Returning no filter
 *     preserves today's behaviour exactly; the two-country split must not
 *     silently narrow what those roles already see.
 *   * ADMIN → restricted to the vendors assigned to them for their
 *     `adminCountry`, and to that country. A misconfigured ADMIN with no
 *     country or no assignments resolves to an empty set (deny), never a leak.
 *
 * The admin's country + assignments are read from the DB per call rather than
 * carried in the JWT, so an assignment change by the Super Admin takes effect
 * immediately without re-issuing anyone's token.
 */

import { Injectable } from "@nestjs/common";
import { Role } from "@prisma/client";

import { PrismaService } from "../prisma.service";
import { type FulfillmentCountry, toFulfillmentCountry } from "../fulfillment-country";

// The generated Prisma Role enum in some build environments predates the ADMIN
// member (migration 0039). Reference it as a string constant so this compiles
// regardless of whether the local client has been regenerated — Prisma enums
// are string-valued at runtime, so the comparison is exact.
const ROLE_ADMIN = "ADMIN" as Role;

export interface AdminScope {
  /** False for SUPER_ADMIN / legacy admin roles — they see everything. */
  restricted: boolean;
  /** The country this admin is limited to, or null when unrestricted. */
  country: FulfillmentCountry | null;
  /**
   * Vendor ids this admin may act on. Empty array = restricted to nothing
   * (deny). `null` = unrestricted (no vendor filter). Only meaningful when
   * `restricted` is true, in which case it is always an array.
   */
  vendorIds: string[] | null;
}

interface AuthLike {
  sub: string;
  role: Role;
}

/**
 * A resolved scope (or null for unrestricted). Accepts the full AdminScope or
 * the trimmed `{ vendorIds, country }` shape passed around the order service.
 */
export type ScopeLike = { vendorIds: string[] | null; country: FulfillmentCountry | null } | null;

/**
 * Prisma `where` fragment for ORDER-shaped tables (filter by the recipient
 * country via `shipCountry`). A CA admin sees only CA-destination orders of
 * their assigned vendors; a US admin sees everything that isn't CA.
 */
export function orderScopeWhere(scope: ScopeLike): {
  vendorId?: { in: string[] };
  shipCountry?: "CA" | { not: "CA" };
} {
  if (!scope) return {};
  const w: { vendorId?: { in: string[] }; shipCountry?: "CA" | { not: "CA" } } = {};
  if (scope.vendorIds) w.vendorId = { in: scope.vendorIds };
  if (scope.country === "CA") w.shipCountry = "CA";
  else if (scope.country === "US") w.shipCountry = { not: "CA" };
  return w;
}

/**
 * Prisma `where` fragment for STOCK-shaped tables (SKUs, PSNs, returns) whose
 * own `country` column holds where the stock lives. A CA admin sees only CA
 * stock of their assigned vendors.
 */
export function stockScopeWhere(scope: ScopeLike): {
  vendorId?: { in: string[] };
  country?: string;
} {
  if (!scope) return {};
  const w: { vendorId?: { in: string[] }; country?: string } = {};
  if (scope.vendorIds) w.vendorId = { in: scope.vendorIds };
  if (scope.country) w.country = scope.country;
  return w;
}

@Injectable()
export class AdminScopeService {
  constructor(private readonly prisma: PrismaService) {}

  /** Resolve the operational scope for the given authenticated user. */
  async resolve(user: AuthLike): Promise<AdminScope> {
    // Unrestricted roles — behaviour unchanged from today.
    if (user.role !== ROLE_ADMIN) {
      return { restricted: false, country: null, vendorIds: null };
    }

    const u = (await this.prisma.user.findUnique({
      where: { id: user.sub },
      select: { id: true },
    })) as unknown as { id: string } | null;
    // Read admin_country via raw cast — column added in 0078; the generated
    // client may lag until `prisma generate` runs on deploy.
    const row = await this.prisma.$queryRaw<Array<{ admin_country: string | null }>>`
      SELECT admin_country FROM users WHERE id = ${user.sub}::uuid
    `;
    const adminCountryRaw = u ? row[0]?.admin_country ?? null : null;

    if (!adminCountryRaw) {
      // An ADMIN with no country assigned can't be scoped safely — deny.
      return { restricted: true, country: null, vendorIds: [] };
    }
    const country = toFulfillmentCountry(adminCountryRaw);

    const assignments = await this.prisma.$queryRaw<Array<{ vendor_id: string }>>`
      SELECT vendor_id FROM vendor_admin_assignments
      WHERE admin_user_id = ${user.sub}::uuid AND country = ${country}
    `;
    return {
      restricted: true,
      country,
      vendorIds: assignments.map((a) => a.vendor_id),
    };
  }

  /**
   * Convenience: a Prisma `where` fragment that limits a vendor-scoped query to
   * this admin's assigned vendors. Returns `{}` (no restriction) for
   * unrestricted roles. For a restricted admin with no assignments it returns
   * an impossible filter so the query yields nothing.
   */
  async vendorWhere(user: AuthLike): Promise<{ vendorId?: { in: string[] } }> {
    const scope = await this.resolve(user);
    if (!scope.restricted) return {};
    return { vendorId: { in: scope.vendorIds ?? [] } };
  }
}
