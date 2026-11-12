/**
 * USA + Canada cutover endpoints (Phase 3), SUPER_ADMIN only.
 *
 *   GET  /v1/admin/migration/readiness        — preconditions + Dishie checkpoint
 *   POST /v1/admin/migration/enable-routing    — gated switch-on
 *   POST /v1/admin/migration/disable-routing   — reverse the switch
 */

import { Body, Controller, Get, HttpCode, HttpStatus, Post } from "@nestjs/common";
import { Role } from "@prisma/client";
import { z } from "zod";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../../common/guards/jwt-auth.guard";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";

import { MigrationService } from "./migration.service";

const enableSchema = z.object({
  confirm: z.boolean(),
  acknowledgePendingCanada: z.boolean().optional(),
});
type EnableInput = z.infer<typeof enableSchema>;

@Controller({ path: "admin/migration", version: "1" })
@Roles(Role.SUPER_ADMIN)
export class MigrationController {
  constructor(private readonly migration: MigrationService) {}

  @Get("readiness")
  readiness() {
    return this.migration.readiness();
  }

  @Post("enable-routing")
  @HttpCode(HttpStatus.OK)
  enable(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(enableSchema)) body: EnableInput,
  ) {
    return this.migration.enableCountryRouting(user.sub, body);
  }

  @Post("disable-routing")
  @HttpCode(HttpStatus.OK)
  disable(@CurrentUser() user: AuthenticatedUser) {
    return this.migration.disableCountryRouting(user.sub);
  }
}
