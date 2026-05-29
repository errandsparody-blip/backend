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

import { Roles } from "../../common/decorators/roles.decorator";
import { PrismaService } from "../../common/prisma.service";

@Controller({ path: "admin/dashboard", version: "1" })
@Roles(Role.WAREHOUSE_OPERATOR, Role.FINANCE_ADMIN, Role.SUPER_ADMIN)
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
}
