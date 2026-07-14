/**
 * Admin controller for warehouse inventory locations (Migration 0045).
 *
 * Routes:
 *   GET    /v1/admin/inventory-locations              — all (SUPER_ADMIN)
 *   GET    /v1/admin/inventory-locations/active       — pack + PSN read
 *   GET    /v1/admin/inventory-locations/lookup/:skuId — SKU → location
 *   POST   /v1/admin/inventory-locations              — create (SUPER_ADMIN)
 *   PATCH  /v1/admin/inventory-locations/:id          — update (SUPER_ADMIN)
 *   POST   /v1/admin/inventory-locations/:id/deactivate — SUPER_ADMIN
 *   POST   /v1/admin/inventory-locations/:id/reactivate — SUPER_ADMIN
 *   PUT    /v1/admin/skus/:skuId/location             — assign (any admin who writes orders)
 *
 * RBAC — class-level open to warehouse operators + FINANCE + SUPER
 * (they all need to READ locations for pick/pack); mutation methods
 * re-restrict to SUPER_ADMIN.
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
} from "@nestjs/common";
import { Prisma, Role } from "@prisma/client";
import { z } from "zod";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../../common/guards/jwt-auth.guard";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { InventoryLocationService } from "../../common/services/inventory-location.service";
import { AuditService } from "../audit/audit.service";

const ROLE_ADMIN = "ADMIN" as Role;

// ---------------------------------------------------------------------------
// Zod schemas — mirror service-side validation. The DB CHECK + service
// asserts remain authoritative; these save the caller a round-trip on
// obvious errors.
// ---------------------------------------------------------------------------

const createSchema = z.object({
  code: z.string().trim().min(2).max(32),
  label: z.string().trim().min(1).max(80),
  aisle: z.string().trim().max(16).optional(),
  bay: z.string().trim().max(16).optional(),
  shelf: z.string().trim().max(16).optional(),
  bin: z.string().trim().max(16).optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
  notes: z.string().trim().max(280).optional(),
});
type CreateInput = z.infer<typeof createSchema>;

const updateSchema = z
  .object({
    label: z.string().trim().min(1).max(80).optional(),
    aisle: z.string().trim().max(16).nullable().optional(),
    bay: z.string().trim().max(16).nullable().optional(),
    shelf: z.string().trim().max(16).nullable().optional(),
    bin: z.string().trim().max(16).nullable().optional(),
    sortOrder: z.number().int().min(0).max(10_000).optional(),
    notes: z.string().trim().max(280).nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "At least one field must be provided.",
  });
type UpdateInput = z.infer<typeof updateSchema>;

const assignSchema = z.object({
  // Nullable so the caller can UNASSIGN by sending explicit null.
  locationId: z.string().uuid().nullable(),
});
type AssignInput = z.infer<typeof assignSchema>;

// ---------------------------------------------------------------------------

@Controller({ path: "admin", version: "1" })
@Roles(Role.WAREHOUSE_OPERATOR, Role.FINANCE_ADMIN, Role.SUPER_ADMIN, ROLE_ADMIN)
export class AdminInventoryLocationController {
  constructor(
    private readonly locations: InventoryLocationService,
    private readonly audit: AuditService,
  ) {}

  // -------------------------------------------------------------------------
  // Reads (open to any admin role)
  // -------------------------------------------------------------------------

  @Get("inventory-locations")
  list() {
    return this.locations.listAll().then((items) => ({ items }));
  }

  @Get("inventory-locations/active")
  listActive() {
    return this.locations.listActive().then((items) => ({ items }));
  }

  @Get("inventory-locations/lookup/:skuId")
  lookup(@Param("skuId") skuId: string) {
    // SKU ids are strings (`UER-…`) not UUIDs — no ParseUUIDPipe.
    return this.locations.lookupForSku(skuId);
  }

  // -------------------------------------------------------------------------
  // Writes — location catalog (SUPER_ADMIN only)
  // -------------------------------------------------------------------------

  @Post("inventory-locations")
  @Roles(Role.SUPER_ADMIN)
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(createSchema)) body: CreateInput,
  ) {
    const created = await this.locations.create(body);
    await this.audit.log({
      actorId: user.sub,
      actorRole: user.role,
      action: "admin.inventory_location.created",
      resourceType: "inventory_location",
      resourceId: created.id,
      afterState: created as unknown as Prisma.InputJsonValue,
    });
    return created;
  }

  @Patch("inventory-locations/:id")
  @Roles(Role.SUPER_ADMIN)
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(updateSchema)) body: UpdateInput,
  ) {
    const before = await this.locations.getById(id);
    const updated = await this.locations.update(id, body);
    await this.audit.log({
      actorId: user.sub,
      actorRole: user.role,
      action: "admin.inventory_location.updated",
      resourceType: "inventory_location",
      resourceId: id,
      beforeState: before as unknown as Prisma.InputJsonValue,
      afterState: updated as unknown as Prisma.InputJsonValue,
    });
    return updated;
  }

  @Post("inventory-locations/:id/deactivate")
  @HttpCode(HttpStatus.OK)
  @Roles(Role.SUPER_ADMIN)
  async deactivate(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", new ParseUUIDPipe()) id: string,
  ) {
    const before = await this.locations.getById(id);
    const updated = await this.locations.deactivate(id);
    await this.audit.log({
      actorId: user.sub,
      actorRole: user.role,
      action: "admin.inventory_location.deactivated",
      resourceType: "inventory_location",
      resourceId: id,
      beforeState: before as unknown as Prisma.InputJsonValue,
      afterState: updated as unknown as Prisma.InputJsonValue,
    });
    return updated;
  }

  @Post("inventory-locations/:id/reactivate")
  @HttpCode(HttpStatus.OK)
  @Roles(Role.SUPER_ADMIN)
  async reactivate(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", new ParseUUIDPipe()) id: string,
  ) {
    const before = await this.locations.getById(id);
    const updated = await this.locations.reactivate(id);
    await this.audit.log({
      actorId: user.sub,
      actorRole: user.role,
      action: "admin.inventory_location.reactivated",
      resourceType: "inventory_location",
      resourceId: id,
      beforeState: before as unknown as Prisma.InputJsonValue,
      afterState: updated as unknown as Prisma.InputJsonValue,
    });
    return updated;
  }

  // -------------------------------------------------------------------------
  // Writes — SKU assignment (any admin who writes orders can also
  // assign locations; SUPER_ADMIN restriction here would block the
  // warehouse team's routine "put this SKU on shelf B2" flow).
  // -------------------------------------------------------------------------

  @Put("skus/:skuId/location")
  @HttpCode(HttpStatus.OK)
  async assign(
    @CurrentUser() user: AuthenticatedUser,
    @Param("skuId") skuId: string,
    @Body(new ZodValidationPipe(assignSchema)) body: AssignInput,
  ) {
    const before = await this.locations.lookupForSku(skuId);
    const result = await this.locations.assignToSku(skuId, body.locationId);
    await this.audit.log({
      actorId: user.sub,
      actorRole: user.role,
      action: body.locationId === null
        ? "admin.sku.location_cleared"
        : "admin.sku.location_assigned",
      resourceType: "sku",
      resourceId: skuId,
      beforeState: {
        locationId: before.location?.id ?? null,
      } as unknown as Prisma.InputJsonValue,
      afterState: {
        locationId: result.locationId,
      } as unknown as Prisma.InputJsonValue,
    });
    return result;
  }
}
