/**
 * Vendor-side team management endpoints.
 *
 *   GET    /v1/team
 *   POST   /v1/team/invitations
 *   POST   /v1/team/invitations/:id/revoke
 *
 * VENDOR (primary) only — sub-users cannot themselves invite or revoke.
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { Role } from "@prisma/client";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../../common/guards/jwt-auth.guard";
import { TenantGuard } from "../../common/guards/tenant.guard";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { inviteSubUserSchema, type InviteSubUserInput } from "../../common/schemas/team.schema";

import { TeamService } from "./team.service";

@Controller({ path: "team", version: "1" })
@Roles(Role.VENDOR)
@UseGuards(TenantGuard)
export class TeamController {
  constructor(private readonly team: TeamService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.team.list(user.vendorId!);
  }

  @Post("invitations")
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async invite(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(inviteSubUserSchema)) body: InviteSubUserInput,
  ) {
    const inv = await this.team.invite(user.vendorId!, user.sub, body.email);
    // Don't return the token; it's emailed.
    return {
      id: inv.id,
      email: inv.email,
      status: inv.status,
      expiresAt: inv.expiresAt,
      createdAt: inv.createdAt,
    };
  }

  @Post("invitations/:id/revoke")
  @HttpCode(HttpStatus.OK)
  async revoke(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", new ParseUUIDPipe()) id: string,
  ) {
    await this.team.revoke(user.vendorId!, user.sub, id);
    return { ok: true };
  }
}
