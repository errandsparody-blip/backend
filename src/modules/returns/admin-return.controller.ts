/**
 * Admin return endpoints. Implementation Plan §6.7.
 *
 *   GET    /v1/admin/returns                 — operator queue
 *   POST   /v1/admin/returns/:id/receive     — mark inbound received
 *   POST   /v1/admin/returns/:id/inspect     — set disposition + refund
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
  Query,
} from "@nestjs/common";
import { Role } from "@prisma/client";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { RequiresPage } from "../../common/decorators/requires-page.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../../common/guards/jwt-auth.guard";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";

// Migration 0039 — ADMIN role reference.
const ROLE_ADMIN = "ADMIN" as Role;
import {
  inspectReturnSchema,
  listReturnsSchema,
  receiveReturnSchema,
  type InspectReturnInput,
  type ListReturnsInput,
  type ReceiveReturnInput,
} from "../../common/schemas/return.schema";

import { ReturnService } from "./return.service";

@Controller({ path: "admin/returns", version: "1" })
// Migration 0039 — ADMIN added. Default is write; GET overrides to
// read. `inspect` triggers refunds to the vendor wallet, but stays
// grantable to ADMIN via config since it doesn't move money OUT of
// the platform — only back to the vendor. SUPER_ADMIN can revoke
// admin.returns.write if they want to lock this down.
@Roles(Role.WAREHOUSE_OPERATOR, Role.FINANCE_ADMIN, Role.SUPER_ADMIN, ROLE_ADMIN)
@RequiresPage("admin.returns.write")
export class AdminReturnController {
  constructor(private readonly returns: ReturnService) {}

  @Get()
  @RequiresPage("admin.returns.read")
  list(@Query(new ZodValidationPipe(listReturnsSchema)) q: ListReturnsInput) {
    return this.returns.adminList(q);
  }

  @Post(":id/receive")
  @HttpCode(HttpStatus.OK)
  receive(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(receiveReturnSchema)) body: ReceiveReturnInput,
  ) {
    return this.returns.adminReceive(user.sub, id, body);
  }

  @Post(":id/inspect")
  @HttpCode(HttpStatus.OK)
  inspect(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(inspectReturnSchema)) body: InspectReturnInput,
  ) {
    return this.returns.adminInspect(user.sub, id, body);
  }
}
