/**
 * Admin dashboard — cross-vendor operational KPIs.
 *
 * Post-migration-0035 / 0036 numbers: the canonical inventory unit
 * shifted from SKU rows to per-box `StorageBox` rows for billing
 * purposes, but SKUs remain the unit for order reservations and the
 * per-piece "units on hand" view. The dashboard exposes both so the
 * operator can see what they're storing (boxes) and what they're
 * fulfilling out of (units).
 *
 * Vendors get a full breakdown by status (`total / active /
 * onboarding / suspended / closed`) because the previous "Active
 * vendors" headline silently hid every vendor not in `status=ACTIVE`,
 * which is the wrong number for "how many merchants do we have on
 * the platform". KYC counters now key off `kycStatus` (more granular
 * than `vendor.status`) so REQUIRES_RESUBMISSION and EXPIRED vendors
 * show up as actionable even though their `vendor.status` is ACTIVE.
 *
 * Implementation Plan §12.4; expanded 2026-05.
 */

import { Controller, Get } from "@nestjs/common";
import { Role } from "@prisma/client";

import { RequiresPage } from "../../common/decorators/requires-page.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { PrismaService } from "../../common/prisma.service";

// Migration 0039 — the ADMIN enum member ships in this migration.
// Referenced as a string cast so the file builds cleanly whether or
// not the local Prisma client has been regenerated (Railway
// regenerates on deploy; local sandboxes may lag).
const ROLE_ADMIN = "ADMIN" as Role;

@Controller({ path: "admin/dashboard", version: "1" })
// ADMIN is added to the compile-time role list here so a SUPER_ADMIN
// can grant `admin.dashboard` via the role-permissions config. The
// PagePermissionGuard is what actually decides — an ADMIN without
// the key set to true will get a 403 even though the role passes.
@Roles(Role.WAREHOUSE_OPERATOR, Role.FINANCE_ADMIN, Role.SUPER_ADMIN, ROLE_ADMIN)
@RequiresPage("admin.dashboard")
export class AdminDashboardController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async overview() {
    const [
      // Vendor breakdown — every status bucket from the VendorStatus enum
      // so the dashboard can show a true "total vendors" headline plus
      // the splits.
      totalVendors,
      activeVendors,
      onboardingVendors,
      suspendedVendors,
      closedVendors,
      // KYC bucket — actionable cases (anything not yet APPROVED / REJECTED
      // that still needs ops attention). Keyed off `kycStatus`, not
      // `vendor.status`, because REQUIRES_RESUBMISSION and EXPIRED can
      // live on an otherwise-ACTIVE vendor.
      kycActionable,
      // Receiving queue — every in-flight PSN status that an operator
      // can act on. SUBMITTED is also actionable in some flows; included
      // alongside AWAITING_RECEIPT for completeness.
      awaitingReceipt,
      partiallyReceived,
      discrepancies,
      onHold,
      // Inventory units — separated billing vs operational view.
      //   activeBoxes:  physical boxes in the warehouse (billing unit).
      //   activeSkuCount: SKU rows still sellable (excludes RESERVED,
      //                   DAMAGED, QUARANTINED, OUT_OF_STOCK).
      //   onHandSum:    sums across ACTIVE + RESERVED SKUs so the total
      //                 reflects everything physically present in the
      //                 warehouse, not just what's free for new orders.
      activeBoxes,
      activeSkuCount,
      onHandSum,
    ] = await this.prisma.$transaction([
      this.prisma.vendor.count(),
      this.prisma.vendor.count({ where: { status: "ACTIVE" } }),
      this.prisma.vendor.count({ where: { status: "PENDING_KYC" } }),
      this.prisma.vendor.count({ where: { status: "SUSPENDED" } }),
      this.prisma.vendor.count({ where: { status: "CLOSED" } }),
      this.prisma.vendor.count({
        where: {
          kycStatus: {
            in: ["PENDING", "IN_PROGRESS", "REQUIRES_RESUBMISSION", "EXPIRED"],
          },
        },
      }),
      this.prisma.psn.count({ where: { status: "AWAITING_RECEIPT" } }),
      this.prisma.psn.count({ where: { status: "PARTIALLY_RECEIVED" } }),
      this.prisma.psn.count({ where: { status: "DISCREPANCY" } }),
      // Migration 0020 added HOLD; an operator needs to see these or
      // they get stuck waiting on a vendor payment with no surface.
      this.prisma.psn.count({ where: { status: "HOLD" } }),
      // Migration 0035 — StorageBox is the per-physical-box billing
      // unit. Includes both billing rows and bundled-with-pallet rows
      // (the latter have null nextBillingDate per migration 0036).
      this.prisma.storageBox.count({ where: { status: "ACTIVE" } }),
      this.prisma.sku.count({ where: { status: "ACTIVE" } }),
      this.prisma.sku.aggregate({
        _sum: { quantityAvailable: true, quantityReserved: true },
        where: { status: { in: ["ACTIVE", "RESERVED"] } },
      }),
    ]);

    return {
      vendors: {
        total: totalVendors,
        active: activeVendors,
        // Renamed in the response shape: `pendingKyc` → `onboarding`
        // matches the VendorStatus enum value semantically. The
        // separate `kycActionable` count uses kycStatus and so can
        // diverge from this number.
        onboarding: onboardingVendors,
        suspended: suspendedVendors,
        closed: closedVendors,
        // Back-compat: older builds of the admin web read
        // `vendors.pendingKyc`. Keep returning it for one release so
        // the page doesn't break mid-deploy.
        pendingKyc: onboardingVendors,
      },
      kyc: {
        actionable: kycActionable,
      },
      receiving: {
        awaiting: awaitingReceipt,
        partial: partiallyReceived,
        discrepancy: discrepancies,
        hold: onHold,
      },
      inventory: {
        // Headline post-migration-0035 — physical boxes the warehouse
        // is holding right now. Includes bundled-with-pallet boxes
        // (visible but not billed independently).
        activeBoxes,
        // Kept for back-compat. `skuCount` is the old field name; the
        // admin web reads it under that name today.
        skuCount: activeSkuCount,
        unitsOnHand: onHandSum._sum.quantityAvailable ?? 0,
        unitsReserved: onHandSum._sum.quantityReserved ?? 0,
      },
    };
  }

  /**
   * Insurable inventory value — the real dollar value of everything
   * physically in our care right now, so ops can size insurance
   * coverage. Value = Σ (product.declared_value_cents × physical units)
   * over on-hand SKUs, where physical units = quantity_available +
   * quantity_reserved (reserved stock is still on the shelf until it
   * ships). Only ACTIVE / RESERVED SKU statuses count — DAMAGED,
   * QUARANTINED and OUT_OF_STOCK are excluded from the insurable figure.
   *
   * The join-aggregate (product value × sku quantity) can't be expressed
   * through Prisma's aggregate() so this uses a raw query. The web tab
   * polls this endpoint, so the headline climbs on its own as new stock
   * is received. Amounts are ::float8 so they arrive as JS numbers, not
   * BigInt — realistic inventory values stay well inside Number's safe
   * integer range (2^53 cents ≈ $90T).
   */
  @Get("inventory-value")
  async inventoryValue() {
    const [totalRows, byVendorRows, byTierRows] = await Promise.all([
      this.prisma.$queryRaw<Array<{ value_cents: number; units: number; sku_count: number }>>`
        SELECT
          COALESCE(SUM(p.declared_value_cents * (s.quantity_available + s.quantity_reserved)), 0)::float8 AS value_cents,
          COALESCE(SUM(s.quantity_available + s.quantity_reserved), 0)::float8 AS units,
          COUNT(*)::float8 AS sku_count
        FROM skus s
        JOIN products p ON p.id = s.product_id
        WHERE s.status IN ('ACTIVE', 'RESERVED')
      `,
      this.prisma.$queryRaw<
        Array<{ vendor_id: string; business_name: string; value_cents: number; units: number }>
      >`
        SELECT
          v.id AS vendor_id,
          v.business_name AS business_name,
          COALESCE(SUM(p.declared_value_cents * (s.quantity_available + s.quantity_reserved)), 0)::float8 AS value_cents,
          COALESCE(SUM(s.quantity_available + s.quantity_reserved), 0)::float8 AS units
        FROM skus s
        JOIN products p ON p.id = s.product_id
        JOIN vendors v ON v.id = s.vendor_id
        WHERE s.status IN ('ACTIVE', 'RESERVED')
        GROUP BY v.id, v.business_name
        HAVING SUM(s.quantity_available + s.quantity_reserved) > 0
        ORDER BY value_cents DESC
      `,
      this.prisma.$queryRaw<Array<{ storage_tier: string; value_cents: number; units: number }>>`
        SELECT
          s.storage_tier AS storage_tier,
          COALESCE(SUM(p.declared_value_cents * (s.quantity_available + s.quantity_reserved)), 0)::float8 AS value_cents,
          COALESCE(SUM(s.quantity_available + s.quantity_reserved), 0)::float8 AS units
        FROM skus s
        JOIN products p ON p.id = s.product_id
        WHERE s.status IN ('ACTIVE', 'RESERVED')
        GROUP BY s.storage_tier
      `,
    ]);

    const total = totalRows[0] ?? { value_cents: 0, units: 0, sku_count: 0 };

    return {
      // Total insurable value of goods physically in our care, in cents.
      totalValueCents: Math.round(total.value_cents),
      totalUnits: Math.round(total.units),
      skuCount: Math.round(total.sku_count),
      // Per-vendor split — biggest exposure first — so ops can see which
      // merchants drive the coverage number.
      byVendor: byVendorRows.map((r) => ({
        vendorId: r.vendor_id,
        businessName: r.business_name,
        valueCents: Math.round(r.value_cents),
        units: Math.round(r.units),
      })),
      byTier: byTierRows.map((r) => ({
        tier: r.storage_tier,
        valueCents: Math.round(r.value_cents),
        units: Math.round(r.units),
      })),
      // Stamp so the auto-refreshing tab can show "as of …".
      asOf: new Date().toISOString(),
    };
  }
}
