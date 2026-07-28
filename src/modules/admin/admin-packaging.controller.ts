/**
 * Admin controller for the packaging library (Migration 0043).
 *
 * Routes:
 *   GET    /v1/admin/packaging-options            — all (active + inactive)
 *   GET    /v1/admin/packaging-options/active     — pack-modal read (any admin)
 *   POST   /v1/admin/packaging-options            — create (SUPER_ADMIN)
 *   PATCH  /v1/admin/packaging-options/:id        — update (SUPER_ADMIN)
 *   POST   /v1/admin/packaging-options/:id/deactivate — SUPER_ADMIN
 *   POST   /v1/admin/packaging-options/:id/reactivate — SUPER_ADMIN
 *
 * RBAC:
 *   * GET /active — any admin who can read the orders queue (pack
 *     modal needs it).
 *   * Everything else — SUPER_ADMIN only. Packaging affects billing
 *     lane classification (flat-rate boxes bill differently), so
 *     write access is deliberately narrow.
 *
 * Every write is audit-logged with before/after JSON via the
 * shared AuditService.
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
} from "@nestjs/common";
import { Prisma, Role } from "@prisma/client";
import { z } from "zod";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { RequiresPage } from "../../common/decorators/requires-page.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../../common/guards/jwt-auth.guard";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { CarrierPackagingRegistryService } from "../../common/services/carrier-packaging-registry";
import { PackagingLibraryService } from "../../common/services/packaging-library.service";
import { AuditService } from "../audit/audit.service";

const ROLE_ADMIN = "ADMIN" as Role;

// ---------------------------------------------------------------------------
// Zod schemas — mirror service-level validation.
// ---------------------------------------------------------------------------

const createSchema = z.object({
  code: z.string().trim().min(2).max(32).regex(/^[a-z0-9_-]+$/i),
  label: z.string().trim().min(1).max(80),
  lengthIn: z.number().positive().max(48),
  widthIn: z.number().positive().max(48),
  heightIn: z.number().positive().max(48),
  tareWeightOz: z.number().int().min(0).max(400).optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
});
type CreateInput = z.infer<typeof createSchema>;

const updateSchema = z
  .object({
    label: z.string().trim().min(1).max(80).optional(),
    lengthIn: z.number().positive().max(48).optional(),
    widthIn: z.number().positive().max(48).optional(),
    heightIn: z.number().positive().max(48).optional(),
    tareWeightOz: z.number().int().min(0).max(400).optional(),
    sortOrder: z.number().int().min(0).max(10_000).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "At least one field must be provided.",
  });
type UpdateInput = z.infer<typeof updateSchema>;

// ---------------------------------------------------------------------------

@Controller({ path: "admin/packaging-options", version: "1" })
@Roles(Role.SUPER_ADMIN)
export class AdminPackagingController {
  constructor(
    private readonly library: PackagingLibraryService,
    // Migration 0049 / Phase N2 — static registry of Shippo's built-in
    // carrier templates. Exposed via /carrier so the pack modal can
    // render the Option-A "Carrier packaging" tab.
    private readonly carrierRegistry: CarrierPackagingRegistryService,
    private readonly audit: AuditService,
  ) {}

  // Reads — the /active + /carrier variants are exposed to any admin
  // (WAREHOUSE_OPERATOR and ADMIN included) so the pack modal can
  // render both the Library and Carrier tabs. Class-level @Roles is
  // overridden at the method level.

  @Get()
  list() {
    return this.library.listAll().then((items) => ({ items }));
  }

  @Get("active")
  @Roles(Role.WAREHOUSE_OPERATOR, Role.FINANCE_ADMIN, Role.SUPER_ADMIN, ROLE_ADMIN)
  @RequiresPage("admin.orders.read")
  listActive() {
    return this.library.listActive().then((items) => ({ items }));
  }

  /**
   * Migration 0049 / Phase N2 — Shippo's built-in carrier templates
   * (Option A in the spec). This is a STATIC list from
   * carrier-packaging-registry.ts; it is not stored in the DB and can
   * only be updated by a code deploy. Selecting one at pack time
   * unlocks flat-rate / one-rate / simple-rate pricing at the Shippo
   * rate request.
   */
  @Get("carrier")
  @Roles(Role.WAREHOUSE_OPERATOR, Role.FINANCE_ADMIN, Role.SUPER_ADMIN, ROLE_ADMIN)
  @RequiresPage("admin.orders.read")
  listCarrier() {
    return { items: this.carrierRegistry.list() };
  }

  @Post()
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(createSchema)) body: CreateInput,
  ) {
    const created = await this.library.create({
      code: body.code,
      label: body.label,
      lengthIn: body.lengthIn,
      widthIn: body.widthIn,
      heightIn: body.heightIn,
      tareWeightOz: body.tareWeightOz,
      sortOrder: body.sortOrder,
    });
    await this.audit.log({
      actorId: user.sub,
      actorRole: user.role,
      action: "admin.packaging_option.created",
      resourceType: "packaging_option",
      resourceId: created.id,
      afterState: created as unknown as Prisma.InputJsonValue,
    });
    return created;
  }

  @Patch(":id")
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(updateSchema)) body: UpdateInput,
  ) {
    const before = await this.library.getById(id);
    const updated = await this.library.update(id, body);
    await this.audit.log({
      actorId: user.sub,
      actorRole: user.role,
      action: "admin.packaging_option.updated",
      resourceType: "packaging_option",
      resourceId: id,
      beforeState: before as unknown as Prisma.InputJsonValue,
      afterState: updated as unknown as Prisma.InputJsonValue,
    });
    return updated;
  }

  @Post(":id/deactivate")
  @HttpCode(HttpStatus.OK)
  async deactivate(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", new ParseUUIDPipe()) id: string,
  ) {
    const before = await this.library.getById(id);
    const updated = await this.library.deactivate(id);
    await this.audit.log({
      actorId: user.sub,
      actorRole: user.role,
      action: "admin.packaging_option.deactivated",
      resourceType: "packaging_option",
      resourceId: id,
      beforeState: before as unknown as Prisma.InputJsonValue,
      afterState: updated as unknown as Prisma.InputJsonValue,
    });
    return updated;
  }

  @Post(":id/reactivate")
  @HttpCode(HttpStatus.OK)
  async reactivate(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", new ParseUUIDPipe()) id: string,
  ) {
    const before = await this.library.getById(id);
    const updated = await this.library.reactivate(id);
    await this.audit.log({
      actorId: user.sub,
      actorRole: user.role,
      action: "admin.packaging_option.reactivated",
      resourceType: "packaging_option",
      resourceId: id,
      beforeState: before as unknown as Prisma.InputJsonValue,
      afterState: updated as unknown as Prisma.InputJsonValue,
    });
    return updated;
  }
}
