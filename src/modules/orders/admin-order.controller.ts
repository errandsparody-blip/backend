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

import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query } from "@nestjs/common";
import { Role } from "@prisma/client";
import { z } from "zod";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { RequiresPage } from "../../common/decorators/requires-page.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../../common/guards/jwt-auth.guard";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { recipientAddressSchema } from "../../common/schemas/order.schema";

import { IntegrationOrderService } from "../integration/integration-order.service";

import { AdminOrderService } from "./admin-order.service";

// Migration 0039 — ADMIN role reference.
const ROLE_ADMIN = "ADMIN" as Role;

const forceCancelSchema = z.object({
  // 5..280: short enough to surface in audit log UI, long enough for a real
  // explanation ("USPS rejected address; vendor confirmed typo, refunding").
  reason: z.string().trim().min(5, "Reason required.").max(280),
});
type ForceCancelInput = z.infer<typeof forceCancelSchema>;

// Edit-recipient body. Reuses the exact schema the vendor order form and
// CSV import validate against — same required phone, same country-aware
// state + postal checks — so an operator edit can't write a shape the
// original create flow would have rejected.
const updateRecipientSchema = recipientAddressSchema;
type UpdateRecipientInput = z.infer<typeof updateRecipientSchema>;

const listSchema = z.object({
  status: z
    .enum([
      "ON_HOLD",
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
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().positive().max(100).default(50),
});
type ListInput = z.infer<typeof listSchema>;

@Controller({ path: "admin/orders", version: "1" })
// Migration 0039 — ADMIN added at class level. Default @RequiresPage
// is `admin.orders.write`; GETs override to `admin.orders.read` so a
// SUPER_ADMIN can grant read-only order queue access without also
// granting pick/pack/ship. `force-cancel` opts BACK OUT of ADMIN at
// the method level because it refunds real money — SUPER_ADMIN only.
@Roles(Role.WAREHOUSE_OPERATOR, Role.FINANCE_ADMIN, Role.SUPER_ADMIN, ROLE_ADMIN)
@RequiresPage("admin.orders.write")
export class AdminOrderController {
  constructor(
    private readonly orders: AdminOrderService,
    // Migration 0038 — resolving a storefront ON_HOLD order re-runs allocation
    // (re-maps SKUs, re-checks funds, reserves + debits) on the held row.
    private readonly integrationOrders: IntegrationOrderService,
  ) {}

  @Get()
  @RequiresPage("admin.orders.read")
  list(@Query(new ZodValidationPipe(listSchema)) q: ListInput) {
    return this.orders.list(q);
  }

  // Migration 0038 — retry allocation on a held storefront order. Use after the
  // blocker is fixed (wallet topped up, SKU received, address corrected). Idempotent:
  // a non-held order is a no-op; a still-blocked order stays held with an updated reason.
  @Post(":id/release")
  @HttpCode(HttpStatus.OK)
  release(@CurrentUser() user: AuthenticatedUser, @Param("id", new ParseUUIDPipe()) id: string) {
    return this.integrationOrders.releaseHeldOrder(id, user.sub);
  }

  @Get(":id")
  @RequiresPage("admin.orders.read")
  get(@Param("id", new ParseUUIDPipe()) id: string) {
    return this.orders.get(id);
  }

  /**
   * Edit the recipient / shipping address on an order that hasn't been
   * charged for shipping yet. Used from the rate picker when a carrier
   * refuses the shipment over the recipient details (missing phone is
   * the common one). On success the operator re-fetches rates and buys
   * the label. The service refuses the edit once the order is
   * SHIPPING_PAID or later.
   */
  @Patch(":id/recipient")
  @HttpCode(HttpStatus.OK)
  updateRecipient(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(updateRecipientSchema)) body: UpdateRecipientInput,
  ) {
    return this.orders.updateRecipient(id, user.sub, {
      recipientName: body.recipientName,
      recipientPhone: body.recipientPhone,
      recipientEmail: body.recipientEmail,
      shipAddressLine1: body.shipAddressLine1,
      shipAddressLine2: body.shipAddressLine2,
      shipCity: body.shipCity,
      shipState: body.shipState,
      shipPostalCode: body.shipPostalCode,
      shipCountry: body.shipCountry,
    });
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

  /**
   * Migration 0037 — terminal hand-off for VENDOR_CARRIER orders.
   *
   * Replaces the `ship` action for orders the vendor brought their
   * own label for. There's no Shippo label to print, no carrier
   * reassessment to run — just the physical hand-off to the vendor's
   * chosen carrier. Status flow: PACKED → HANDED_OFF.
   *
   * The service-side guard refuses to advance PLATFORM_SHIP orders
   * through this endpoint; those still go through `ship`.
   */
  @Post(":id/handed-off")
  @HttpCode(HttpStatus.OK)
  handedOff(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", new ParseUUIDPipe()) id: string,
  ) {
    return this.orders.markHandedOff(id, user.sub);
  }

  /**
   * Force-cancel a stuck order. Releases inventory + refunds the wallet in
   * one transaction. Used when a label can't be purchased (e.g. invalid
   * recipient address at the carrier) and the order would otherwise sit
   * indefinitely in ALLOCATED / LABEL_PURCHASED state.
   *
   * The vendor's normal cancel flow handles DRAFT / SUBMITTED / ALLOCATED;
   * this admin endpoint additionally covers LABEL_PURCHASED. Anything past
   * that (PICKING and beyond) requires the return flow because real-world
   * activity has happened.
   */
  // Migration 0039 — force-cancel refunds the wallet in the same
  // transaction as the inventory release. Method-level @Roles
  // OVERRIDES the class-level list, dropping ADMIN + WAREHOUSE_OPERATOR
  // so this is only ever reachable by FINANCE_ADMIN or SUPER_ADMIN.
  // Deliberately has no @RequiresPage — no config toggle can grant
  // it to an ADMIN.
  @Roles(Role.FINANCE_ADMIN, Role.SUPER_ADMIN)
  @Post(":id/force-cancel")
  @HttpCode(HttpStatus.OK)
  forceCancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(forceCancelSchema)) body: ForceCancelInput,
  ) {
    return this.orders.forceCancel(id, user.sub, body.reason);
  }
}
