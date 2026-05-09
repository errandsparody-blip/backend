/**
 * Admin / operator order endpoints. Implementation Plan §6.6.
 *
 * Routes:
 *   GET    /v1/admin/orders        — operator queue (default: ALLOCATED..PACKED)
 *   GET    /v1/admin/orders/:id    — full detail with timeline
 *   POST   /v1/admin/orders/:id/purchase-label
 *   POST   /v1/admin/orders/:id/pick
 *   POST   /v1/admin/orders/:id/pack
 *   POST   /v1/admin/orders/:id/ship
 *
 * Roles: WAREHOUSE_OPERATOR, FINANCE_ADMIN, SUPER_ADMIN.
 */

import { Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query } from "@nestjs/common";
import { Role } from "@prisma/client";
import { z } from "zod";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../../common/guards/jwt-auth.guard";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";

import { AdminOrderService } from "./admin-order.service";

const listSchema = z.object({
  status: z
    .enum([
      "ALLOCATED",
      "LABEL_PURCHASED",
      "PICKING",
      "PACKED",
      "SHIPPED",
      "IN_TRANSIT",
      "DELIVERED",
      "EXCEPTION",
      "CANCELLED",
      "RETURNED",
    ])
    .optional(),
  /**
   * Without this flag, the service falls back to "queue mode" (ALLOCATED
   * → PACKED) so the operator's default screen is the work in front of
   * them. Pass `view=all` to see every order regardless of status —
   * needed for "where's my shipped order?" lookups and audit trails.
   */
  view: z.enum(["queue", "all"]).optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().positive().max(100).default(50),
});
type ListInput = z.infer<typeof listSchema>;

@Controller({ path: "admin/orders", version: "1" })
@Roles(Role.WAREHOUSE_OPERATOR, Role.FINANCE_ADMIN, Role.SUPER_ADMIN)
export class AdminOrderController {
  constructor(private readonly orders: AdminOrderService) {}

  @Get()
  list(@Query(new ZodValidationPipe(listSchema)) q: ListInput) {
    return this.orders.list(q);
  }

  @Get(":id")
  get(@Param("id", new ParseUUIDPipe()) id: string) {
    return this.orders.get(id);
  }

  @Post(":id/purchase-label")
  @HttpCode(HttpStatus.OK)
  purchaseLabel(@CurrentUser() user: AuthenticatedUser, @Param("id", new ParseUUIDPipe()) id: string) {
    return this.orders.purchaseLabel(id, user.sub);
  }

  @Post(":id/pick")
  @HttpCode(HttpStatus.OK)
  pick(@CurrentUser() user: AuthenticatedUser, @Param("id", new ParseUUIDPipe()) id: string) {
    return this.orders.pick(id, user.sub);
  }

  @Post(":id/pack")
  @HttpCode(HttpStatus.OK)
  pack(@CurrentUser() user: AuthenticatedUser, @Param("id", new ParseUUIDPipe()) id: string) {
    return this.orders.pack(id, user.sub);
  }

  @Post(":id/ship")
  @HttpCode(HttpStatus.OK)
  ship(@CurrentUser() user: AuthenticatedUser, @Param("id", new ParseUUIDPipe()) id: string) {
    return this.orders.ship(id, user.sub);
  }
}
