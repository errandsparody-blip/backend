/**
 * Admin dashboard — cross-vendor operational KPIs.
 *
 * The shape is intentionally small in P1; P2+ adds wallet float, order queue,
 * fulfillment SLA. Implementation Plan §12.4.
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
      activeVendors,
      pendingKyc,
      awaitingReceipt,
      partiallyReceived,
      discrepancies,
      activeSkuCount,
      onHandSum,
    ] = await this.prisma.$transaction([
      this.prisma.vendor.count({ where: { status: "ACTIVE" } }),
      this.prisma.vendor.count({ where: { status: "PENDING_KYC" } }),
      this.prisma.psn.count({ where: { status: "AWAITING_RECEIPT" } }),
      this.prisma.psn.count({ where: { status: "PARTIALLY_RECEIVED" } }),
      this.prisma.psn.count({ where: { status: "DISCREPANCY" } }),
      this.prisma.sku.count({ where: { status: "ACTIVE" } }),
      this.prisma.sku.aggregate({
        _sum: { quantityAvailable: true, quantityReserved: true },
        where: { status: "ACTIVE" },
      }),
    ]);

    return {
      vendors: { active: activeVendors, pendingKyc },
      receiving: { awaiting: awaitingReceipt, partial: partiallyReceived, discrepancy: discrepancies },
      inventory: {
        skuCount: activeSkuCount,
        unitsOnHand: onHandSum._sum.quantityAvailable ?? 0,
        unitsReserved: onHandSum._sum.quantityReserved ?? 0,
      },
    };
  }
}
