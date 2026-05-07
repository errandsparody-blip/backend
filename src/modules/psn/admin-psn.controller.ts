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
  completeReceivingSchema,
  listPsnsSchema,
  type CompleteReceivingInput,
  type ListPsnsInput,
} from "../../common/schemas/psn.schema";

import { AdminPsnService } from "./admin-psn.service";

@Controller({ path: "admin/psns", version: "1" })
@Roles(Role.WAREHOUSE_OPERATOR, Role.FINANCE_ADMIN, Role.SUPER_ADMIN)
export class AdminPsnController {
  constructor(private readonly admin: AdminPsnService) {}

  @Get()
  list(@Query(new ZodValidationPipe(listPsnsSchema)) q: ListPsnsInput) {
    return this.admin.listIncoming(q);
  }

  @Get(":id")
  get(@Param("id", new ParseUUIDPipe()) id: string) {
    return this.admin.get(id);
  }

  @Post(":id/receive")
  @HttpCode(HttpStatus.OK)
  receive(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(completeReceivingSchema)) body: CompleteReceivingInput,
  ) {
    return this.admin.completeReceiving(id, user.sub, body);
  }
}
