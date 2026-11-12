/**
 * Shippo sender-profile management (SUPER_ADMIN only). USA + Canada, 0082.
 *
 *   GET    /v1/admin/shippo-senders        — list profiles
 *   PUT    /v1/admin/shippo-senders        — create/update a profile (by key)
 *   DELETE /v1/admin/shippo-senders/:key   — remove a profile
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Put,
} from "@nestjs/common";
import { Role } from "@prisma/client";
import { z } from "zod";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../../common/guards/jwt-auth.guard";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";

import { SenderProfileService } from "./sender-profile.service";

const upsertSchema = z.object({
  // Admin user id (uuid) or the literal "DEFAULT".
  key: z.string().min(1).max(64),
  label: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(120),
  phone: z.string().trim().min(7).max(40),
  email: z.string().trim().email().max(254),
  line1: z.string().trim().min(1).max(120),
  line2: z.string().trim().max(120).optional().or(z.literal("").transform(() => undefined)),
  city: z.string().trim().min(1).max(80),
  state: z.string().trim().min(2).max(40),
  postalCode: z.string().trim().min(3).max(12),
  country: z.enum(["US", "CA"]).default("US"),
});
type UpsertInput = z.infer<typeof upsertSchema>;

@Controller({ path: "admin/shippo-senders", version: "1" })
@Roles(Role.SUPER_ADMIN)
export class SenderProfileController {
  constructor(private readonly senders: SenderProfileService) {}

  @Get()
  list() {
    return this.senders.list();
  }

  @Put()
  @HttpCode(HttpStatus.OK)
  upsert(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(upsertSchema)) body: UpsertInput,
  ) {
    return this.senders.upsert(user.sub, { ...body, line2: body.line2 ?? null });
  }

  @Delete(":key")
  @HttpCode(HttpStatus.OK)
  remove(@CurrentUser() user: AuthenticatedUser, @Param("key") key: string) {
    return this.senders.remove(user.sub, key);
  }
}
