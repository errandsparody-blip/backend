/**
 * Operational-admin overview — a small at-a-glance snapshot for the ADMIN
 * role: how many vendors they look after, how many orders are waiting on them,
 * and how many PSNs are awaiting receipt. Everything is resolved through
 * AdminScopeService, so an ADMIN only ever sees counts for their assigned
 * vendors + their country. SUPER_ADMIN / legacy roles get platform-wide totals.
 */

import { Controller, Get } from "@nestjs/common";
import { Prisma, type OrderStatus, Role } from "@prisma/client";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../../common/guards/jwt-auth.guard";
import { PrismaService } from "../../common/prisma.service";
import {
  AdminScopeService,
  orderScopeWhere,
  stockScopeWhere,
} from "../../common/services/admin-scope.service";

const ROLE_ADMIN = "ADMIN" as Role;

// Orders still needing work from an operator (not terminal).
const PENDING_ORDER_STATUSES = [
  "PENDING_PACKING",
  "PACKING_COMPLETED",
  "AWAITING_SHIPPING_SELECTION",
  "AWAITING_WALLET_FUNDING",
  "ON_HOLD",
] as unknown as OrderStatus[];

@Controller({ path: "admin/overview", version: "1" })
@Roles(Role.SUPER_ADMIN, Role.FINANCE_ADMIN, Role.WAREHOUSE_OPERATOR, ROLE_ADMIN)
export class AdminOverviewController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly adminScope: AdminScopeService,
  ) {}

  @Get()
  async myOverview(@CurrentUser() user: AuthenticatedUser) {
    const scope = await this.adminScope.resolve(user);
    const s = scope.restricted ? scope : null;

    const assignedVendors = scope.restricted
      ? (scope.vendorIds ?? []).length
      : await this.prisma.vendor.count();

    const pendingOrders = await this.prisma.order.count({
      where: { status: { in: PENDING_ORDER_STATUSES }, ...orderScopeWhere(s) },
    });

    const awaitingPsns = await this.prisma.psn.count({
      where: {
        status: "AWAITING_RECEIPT",
        ...(stockScopeWhere(s) as Prisma.PsnWhereInput),
      },
    });

    return {
      country: scope.restricted ? scope.country : null,
      assignedVendors,
      pendingOrders,
      awaitingPsns,
    };
  }
}
