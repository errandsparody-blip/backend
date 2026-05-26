/**
 * Admin endpoints for the per-box consolidation workflow (migration
 * 0035). The vendor's recurring-storage page is read-only; this is
 * where staff actually flip boxes out of billing.
 *
 * Three state transitions:
 *   - ACTIVE → EMPTY      (POST /admin/storage-boxes/:id/mark-empty)
 *   - any   → REMOVED     (POST /admin/storage-boxes/:id/remove)
 *   - EMPTY/REMOVED → ACTIVE (POST /admin/storage-boxes/:id/restore)
 *
 * All three are SUPER_ADMIN only — flipping a box out of billing
 * directly affects what we charge the vendor, so we keep the surface
 * narrow. FINANCE_ADMIN can READ via the list endpoint on the vendor
 * controller but can't mutate.
 *
 * Each call is throttled per actor so a runaway script can't
 * accidentally zero out a vendor's billing.
 */

import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from "@nestjs/common";
import { Role } from "@prisma/client";
import { Throttle } from "@nestjs/throttler";
import { z } from "zod";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../../common/guards/jwt-auth.guard";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";

import { AdminVendorService } from "./admin-vendor.service";

/**
 * Note body for any box state change. Capped at 500 chars so it stays
 * a one-liner in the audit log; longer context belongs in a separate
 * support ticket.
 */
const noteSchema = z
  .object({
    note: z.string().trim().max(500).optional(),
  })
  .strict();

type NoteInput = z.infer<typeof noteSchema>;

@Controller({ path: "admin/storage-boxes", version: "1" })
export class AdminStorageBoxController {
  constructor(private readonly vendors: AdminVendorService) {}

  @Roles(Role.SUPER_ADMIN)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Post(":id/mark-empty")
  @HttpCode(HttpStatus.OK)
  async markEmpty(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(noteSchema)) body: NoteInput,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<{ id: string; status: string }> {
    return this.vendors.markBoxEmpty(id, { actorId: actor.sub, note: body.note });
  }

  @Roles(Role.SUPER_ADMIN)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Post(":id/remove")
  @HttpCode(HttpStatus.OK)
  async remove(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(noteSchema)) body: NoteInput,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<{ id: string; status: string }> {
    return this.vendors.removeBox(id, { actorId: actor.sub, note: body.note });
  }

  @Roles(Role.SUPER_ADMIN)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Post(":id/restore")
  @HttpCode(HttpStatus.OK)
  async restore(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(noteSchema)) body: NoteInput,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<{ id: string; status: string }> {
    return this.vendors.restoreBox(id, { actorId: actor.sub, note: body.note });
  }
}
