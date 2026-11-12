/**
 * Admin earnings & settlements (Phases 7 & 8).
 *
 *   Super Admin:
 *     GET  /v1/admin/earnings/fee-settings
 *     PUT  /v1/admin/earnings/fee-settings           { platformBps, processingBps }
 *     GET  /v1/admin/earnings/preview?adminUserId&kind&from&to
 *     POST /v1/admin/earnings/settlements            create a settlement
 *     POST /v1/admin/earnings/settlements/:id/paid   mark paid + receipt
 *     GET  /v1/admin/earnings/settlements[?adminUserId]
 *   Operational admin:
 *     GET  /v1/admin/earnings/my-settlements
 *     POST /v1/admin/earnings/settlements/:id/respond { outcome, note }
 */

import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Put, Query } from "@nestjs/common";
import { Role } from "@prisma/client";
import { z } from "zod";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../../common/guards/jwt-auth.guard";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";

import { EarningsService } from "./earnings.service";

const ROLE_ADMIN = "ADMIN" as Role;

const feeSchema = z.object({
  platformBps: z.number().int().min(0).max(10_000),
  processingBps: z.number().int().min(0).max(10_000),
});
type FeeInput = z.infer<typeof feeSchema>;

const createSchema = z.object({
  adminUserId: z.string().uuid(),
  kind: z.enum(["FULFILLMENT", "STORAGE"]),
  from: z.coerce.date(),
  to: z.coerce.date(),
});
type CreateInput = z.infer<typeof createSchema>;

const paidSchema = z.object({
  receiptUrl: z.string().url().max(2048).optional(),
  note: z.string().trim().max(500).optional(),
});
type PaidInput = z.infer<typeof paidSchema>;

const respondSchema = z.object({
  outcome: z.enum(["CONFIRMED", "DISPUTED"]),
  note: z.string().trim().max(500).optional(),
});
type RespondInput = z.infer<typeof respondSchema>;

const previewSchema = createSchema;

@Controller({ path: "admin/earnings", version: "1" })
@Roles(Role.SUPER_ADMIN, ROLE_ADMIN)
export class EarningsController {
  constructor(private readonly earnings: EarningsService) {}

  // --- super admin ---------------------------------------------------------

  @Get("fee-settings")
  @Roles(Role.SUPER_ADMIN)
  feeSettings() {
    return this.earnings.getFeeSettings();
  }

  @Put("fee-settings")
  @Roles(Role.SUPER_ADMIN)
  @HttpCode(HttpStatus.OK)
  setFees(@CurrentUser() u: AuthenticatedUser, @Body(new ZodValidationPipe(feeSchema)) b: FeeInput) {
    return this.earnings.setFeeSettings(u.sub, b);
  }

  @Get("preview")
  @Roles(Role.SUPER_ADMIN)
  preview(@Query(new ZodValidationPipe(previewSchema)) q: CreateInput) {
    return q.kind === "FULFILLMENT"
      ? this.earnings.fulfillmentEarnings(q.adminUserId, q.from, q.to)
      : this.earnings.storageEarnings(q.adminUserId, q.from, q.to);
  }

  @Post("settlements")
  @Roles(Role.SUPER_ADMIN)
  @HttpCode(HttpStatus.OK)
  create(@CurrentUser() u: AuthenticatedUser, @Body(new ZodValidationPipe(createSchema)) b: CreateInput) {
    return this.earnings.createSettlement(u.sub, b);
  }

  @Post("settlements/:id/paid")
  @Roles(Role.SUPER_ADMIN)
  @HttpCode(HttpStatus.OK)
  markPaid(
    @CurrentUser() u: AuthenticatedUser,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(paidSchema)) b: PaidInput,
  ) {
    return this.earnings.markPaid(u.sub, id, b);
  }

  @Get("settlements")
  @Roles(Role.SUPER_ADMIN)
  list(@Query("adminUserId") adminUserId?: string) {
    return this.earnings.list({ ...(adminUserId ? { adminUserId } : {}) });
  }

  // --- operational admin ---------------------------------------------------

  @Get("my-settlements")
  mySettlements(@CurrentUser() u: AuthenticatedUser) {
    return this.earnings.list({ adminUserId: u.sub });
  }

  @Post("settlements/:id/respond")
  @HttpCode(HttpStatus.OK)
  respond(
    @CurrentUser() u: AuthenticatedUser,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(respondSchema)) b: RespondInput,
  ) {
    return this.earnings.respond(u.sub, id, b.outcome, b.note);
  }
}
