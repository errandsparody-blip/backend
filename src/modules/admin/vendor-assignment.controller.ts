/**
 * Vendor ⇄ operational-admin assignment management (SUPER_ADMIN only).
 * USA + Canada, migration 0078.
 *
 *   GET    /v1/admin/vendor-assignments           — list all assignments
 *   PUT    /v1/admin/vendor-assignments           — assign (upsert) a vendor
 *   DELETE /v1/admin/vendor-assignments           — unassign a vendor/country
 *   PUT    /v1/admin/admins/:id/country           — set an admin's country
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Put,
  Query,
} from "@nestjs/common";
import { Role } from "@prisma/client";
import { z } from "zod";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../../common/guards/jwt-auth.guard";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";

import { VendorAssignmentService } from "./vendor-assignment.service";

const country = z.enum(["US", "CA"]);

const assignSchema = z.object({
  vendorId: z.string().uuid(),
  country,
  adminUserId: z.string().uuid(),
});
type AssignInput = z.infer<typeof assignSchema>;

const unassignSchema = z.object({
  vendorId: z.string().uuid(),
  country,
});
type UnassignInput = z.infer<typeof unassignSchema>;

const setCountrySchema = z.object({
  // null clears the admin's country scope.
  country: country.nullable(),
});
type SetCountryInput = z.infer<typeof setCountrySchema>;

@Controller({ path: "admin", version: "1" })
@Roles(Role.SUPER_ADMIN)
export class VendorAssignmentController {
  constructor(private readonly assignments: VendorAssignmentService) {}

  @Get("vendor-assignments")
  list() {
    return this.assignments.list();
  }

  @Put("vendor-assignments")
  @HttpCode(HttpStatus.OK)
  assign(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(assignSchema)) body: AssignInput,
  ) {
    return this.assignments.assign(user.sub, body);
  }

  @Delete("vendor-assignments")
  @HttpCode(HttpStatus.OK)
  unassign(
    @CurrentUser() user: AuthenticatedUser,
    @Query(new ZodValidationPipe(unassignSchema)) query: UnassignInput,
  ) {
    return this.assignments.unassign(user.sub, query.vendorId, query.country);
  }

  @Put("admins/:id/country")
  @HttpCode(HttpStatus.OK)
  setCountry(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(setCountrySchema)) body: SetCountryInput,
  ) {
    return this.assignments.setAdminCountry(user.sub, id, body.country);
  }
}
