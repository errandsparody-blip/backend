/**
 * Admin configuration management.
 *
 * Implementation Plan §6.13.
 *
 *   GET    /v1/admin/config                — list configuration keys
 *   GET    /v1/admin/config/:key           — read a single key
 *   PATCH  /v1/admin/config/:key           — replace the value, audit-logged
 *
 * SUPER_ADMIN only. Every mutation captures the full before/after JSON in
 * the audit log so a forensic review can reconstruct any change.
 *
 * NOTE: v1 accepts the new value as-is. A two-person change-control flow
 * (proposed change + second approver) is tracked as a follow-up.
 */

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
} from "@nestjs/common";
import { Role } from "@prisma/client";
import { z } from "zod";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../../common/guards/jwt-auth.guard";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { PrismaService } from "../../common/prisma.service";
import { AuditService } from "../audit/audit.service";

const KEY_RE = /^[a-z0-9_]{2,64}$/;

const updateSchema = z.object({
  // Accept any JSON; the configuration table is intentionally schema-loose
  // because tenant_dimensions / fee_schedule / repackaging_fees have very
  // different shapes. The frontend renders a JSON editor.
  value: z.unknown().refine((v) => v !== undefined, "value is required"),
  description: z.string().trim().max(500).optional(),
});
type UpdateInput = z.infer<typeof updateSchema>;

@Controller({ path: "admin/config", version: "1" })
@Roles(Role.SUPER_ADMIN)
export class AdminConfigController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async list() {
    const rows = await this.prisma.configuration.findMany({
      orderBy: { key: "asc" },
      select: { key: true, description: true, updatedAt: true, updatedBy: true },
    });
    return { items: rows };
  }

  @Get(":key")
  async get(@Param("key") key: string) {
    if (!KEY_RE.test(key)) {
      throw new BadRequestException({ message: "key must match [a-z0-9_]{2,64}", code: "config_key_invalid" });
    }
    const row = await this.prisma.configuration.findUnique({ where: { key } });
    if (!row) {
      throw new BadRequestException({ message: `Unknown configuration key: ${key}`, code: "config_unknown" });
    }
    return row;
  }

  @Patch(":key")
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param("key") key: string,
    @Body(new ZodValidationPipe(updateSchema)) body: UpdateInput,
  ) {
    if (!KEY_RE.test(key)) {
      throw new BadRequestException({ message: "key must match [a-z0-9_]{2,64}", code: "config_key_invalid" });
    }

    const before = await this.prisma.configuration.findUnique({ where: { key } });
    if (!before) {
      throw new BadRequestException({ message: `Unknown configuration key: ${key}`, code: "config_unknown" });
    }

    const updated = await this.prisma.configuration.update({
      where: { key },
      data: {
        value: body.value as object,
        ...(body.description !== undefined ? { description: body.description } : {}),
        updatedBy: user.sub,
      },
    });

    await this.audit.log({
      actorId: user.sub,
      actorRole: user.role,
      action: "config.updated",
      resourceType: "configuration",
      resourceId: key,
      beforeState: { value: before.value, description: before.description },
      afterState: { value: updated.value, description: updated.description },
    });

    return updated;
  }
}
