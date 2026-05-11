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
  placeHoldSchema,
  rejectPsnSchema,
  requestPsnReturnSchema,
  type CompleteReceivingInput,
  type ListPsnsInput,
  type PlaceHoldInput,
  type RejectPsnInput,
  type RequestPsnReturnInput,
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

  /** Phase 2 — return the currently-active hold (or null) for a PSN. */
  @Get(":id/active-hold")
  activeHold(@Param("id", new ParseUUIDPipe()) id: string) {
    return this.admin.activeHoldFor(id);
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

  /**
   * Phase 2 — place the PSN on Hold pending an extra payment from vendor.
   * Status: AWAITING_RECEIPT / PARTIALLY_RECEIVED / DISCREPANCY → HOLD.
   */
  @Post(":id/hold")
  @HttpCode(HttpStatus.OK)
  placeHold(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(placeHoldSchema)) body: PlaceHoldInput,
  ) {
    return this.admin.placeHold(id, user.sub, body);
  }

  /**
   * Phase 2 — refuse the PSN outright. No inventory. Onboarding fee stays
   * debited (finance can refund separately if appropriate).
   */
  @Post(":id/reject")
  @HttpCode(HttpStatus.OK)
  reject(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(rejectPsnSchema)) body: RejectPsnInput,
  ) {
    return this.admin.reject(id, user.sub, body);
  }

  /**
   * Phase 2 — ship the package back to the vendor unopened. Wallet debits
   * the return-shipping cost immediately (insufficient funds → 4xx, admin
   * resolves).
   */
  @Post(":id/request-return")
  @HttpCode(HttpStatus.OK)
  requestReturn(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(requestPsnReturnSchema)) body: RequestPsnReturnInput,
  ) {
    return this.admin.requestReturn(id, user.sub, body);
  }
}
