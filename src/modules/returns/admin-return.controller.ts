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
import { Roles } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../../common/guards/jwt-auth.guard";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
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
@Roles(Role.WAREHOUSE_OPERATOR, Role.FINANCE_ADMIN, Role.SUPER_ADMIN)
export class AdminReturnController {
  constructor(private readonly returns: ReturnService) {}

  @Get()
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
