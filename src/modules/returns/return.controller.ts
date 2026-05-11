/**
 * Vendor-facing return endpoints. Implementation Plan §6.7.
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
  UseGuards,
} from "@nestjs/common";
import { Role } from "@prisma/client";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../../common/guards/jwt-auth.guard";
import { TenantGuard } from "../../common/guards/tenant.guard";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { PrismaService } from "../../common/prisma.service";
import {
  createReturnSchema,
  listReturnsSchema,
  presignReturnUploadSchema,
  type CreateReturnInput,
  type ListReturnsInput,
  type PresignReturnUploadInput,
} from "../../common/schemas/return.schema";
import { R2Service } from "../integrations/r2/r2.service";

import { ReturnService } from "./return.service";

@Controller({ path: "returns", version: "1" })
@Roles(Role.VENDOR, Role.VENDOR_SUB_USER)
@UseGuards(TenantGuard)
export class ReturnController {
  constructor(
    private readonly returns: ReturnService,
    private readonly r2: R2Service,
    private readonly prisma: PrismaService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(createReturnSchema)) body: CreateReturnInput,
  ) {
    return this.returns.create(user.vendorId!, user.sub, body);
  }

  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query(new ZodValidationPipe(listReturnsSchema)) q: ListReturnsInput,
  ) {
    return this.returns.list(user.vendorId!, q);
  }

  /**
   * Detail GET. Augments the bare return row with a server-computed
   * `potentialRefundCents` (best-case refund based on requested qty ×
   * order-line unit price) so the vendor sees what they could expect
   * before the inspection lands. Once status reaches RESTOCKED /
   * DISPOSED / REJECTED the actual `refundAmountCents` is the truth;
   * the potential is informational only.
   */
  @Get(":id")
  async get(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", new ParseUUIDPipe()) id: string,
  ) {
    const ret = await this.returns.get(user.vendorId!, id);
    const potentialRefundCents = await this.computePotentialRefund(ret);
    return { ...ret, potentialRefundCents };
  }

  @Post(":id/cancel")
  @HttpCode(HttpStatus.OK)
  cancel(@CurrentUser() user: AuthenticatedUser, @Param("id", new ParseUUIDPipe()) id: string) {
    return this.returns.cancel(user.vendorId!, user.sub, id);
  }

  /**
   * Presign a single PUT for a return-attachment upload. Used by the
   * AttachmentUploader on the request-return form so vendors can drop
   * photos / receipts at RMA-creation time. Tenant-scoped via the
   * outer @Roles + @UseGuards(TenantGuard); the key prefix scopes
   * objects to this vendor so cross-tenant key collisions are
   * impossible even if R2 keys leak.
   */
  @Post("uploads")
  @HttpCode(HttpStatus.OK)
  async presignUpload(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(presignReturnUploadSchema)) body: PresignReturnUploadInput,
  ) {
    const key = this.r2.generateKey(`returns/${user.vendorId}/evidence`, body.filename);
    return this.r2.presignPut({
      key,
      contentType: body.contentType,
      contentLengthBytes: body.contentLengthBytes,
    });
  }

  /**
   * Compute the potential refund as the sum of (requestedQty ×
   * order-line unit price). Unit price is derived from
   * declaredValueCents / quantity on the originating order line.
   * Best-effort — if the order line was deleted or the quantity is
   * zero, that line contributes 0.
   */
  private async computePotentialRefund(ret: {
    orderId: string;
    lines: Array<{ orderLineId: string; requestedQty: number }>;
  }): Promise<number> {
    if (ret.lines.length === 0) return 0;
    const orderLines = await this.prisma.orderLine.findMany({
      where: { id: { in: ret.lines.map((l) => l.orderLineId) }, orderId: ret.orderId },
      select: { id: true, quantity: true, declaredValueCents: true },
    });
    const lineById = new Map(orderLines.map((l) => [l.id, l]));
    let total = 0;
    for (const rl of ret.lines) {
      const ol = lineById.get(rl.orderLineId);
      if (!ol || ol.quantity <= 0) continue;
      const unitCents = Math.floor(ol.declaredValueCents / ol.quantity);
      total += unitCents * rl.requestedQty;
    }
    return total;
  }
}
