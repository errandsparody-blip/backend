/**
 * AdminVendorController — vendor management endpoints for USA Errands staff.
 * Hosts the manual KYC decision flow + the social verification stamp.
 *
 * Authorization is two-tiered:
 *   - GET endpoints (list / detail): FINANCE_ADMIN + SUPER_ADMIN
 *   - State-changing endpoints (approve / reject / resubmit / verify social):
 *     SUPER_ADMIN only. Approving someone for KYC is a fraud-control surface;
 *     it stays narrowly scoped until we add a dedicated COMPLIANCE_REVIEWER
 *     role.
 *
 * Implementation Plan §11.2 (Admin — Vendors / KYC).
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
} from "@nestjs/common";
import { Role } from "@prisma/client";
import { Throttle } from "@nestjs/throttler";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../../common/guards/jwt-auth.guard";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import {
  approveKycSchema,
  rejectKycSchema,
  requestResubmissionSchema,
  verifySocialSchema,
  type ApproveKycInput,
  type RejectKycInput,
  type RequestResubmissionInput,
  type VerifySocialInput,
} from "../../common/schemas/admin-vendor.schema";

import { AdminVendorService } from "./admin-vendor.service";

@Controller({ path: "admin/vendors", version: "1" })
export class AdminVendorController {
  constructor(private readonly vendors: AdminVendorService) {}

  // ---------------------------------------------------------------------------
  // Read
  // ---------------------------------------------------------------------------

  @Roles(Role.FINANCE_ADMIN, Role.SUPER_ADMIN)
  @Get(":id")
  async detail(@Param("id", new ParseUUIDPipe()) id: string) {
    return this.vendors.getVendorDetail(id);
  }

  /**
   * Operational snapshot — lifetime spend, recurring storage estimate,
   * PSNs / orders / returns counts plus the 10 most-recent of each, an
   * inventory-by-tier breakdown, and the latest 25 ledger entries.
   *
   * Returned in a single round-trip so the admin detail page renders
   * without a waterfall. Read-only — same FINANCE_ADMIN + SUPER_ADMIN
   * scope as the detail endpoint.
   */
  @Roles(Role.FINANCE_ADMIN, Role.SUPER_ADMIN)
  @Get(":id/overview")
  async overview(@Param("id", new ParseUUIDPipe()) id: string) {
    return this.vendors.getVendorOverview(id);
  }

  // ---------------------------------------------------------------------------
  // KYC decisions — SUPER_ADMIN only.
  //
  // Each decision endpoint is throttled per-actor. Approving 100 vendors in a
  // minute is not a normal pattern; if it happens, that's worth a review.
  // ---------------------------------------------------------------------------

  @Roles(Role.SUPER_ADMIN)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post(":id/kyc/approve")
  @HttpCode(HttpStatus.OK)
  async approveKyc(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(approveKycSchema)) body: ApproveKycInput,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.vendors.approveKyc(id, { actorId: actor.sub, notes: body.notes });
  }

  @Roles(Role.SUPER_ADMIN)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post(":id/kyc/reject")
  @HttpCode(HttpStatus.OK)
  async rejectKyc(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(rejectKycSchema)) body: RejectKycInput,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.vendors.rejectKyc(id, body.reason, { actorId: actor.sub });
  }

  @Roles(Role.SUPER_ADMIN)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post(":id/kyc/request-resubmission")
  @HttpCode(HttpStatus.OK)
  async requestResubmission(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(requestResubmissionSchema)) body: RequestResubmissionInput,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.vendors.requestResubmission(id, body.reason, { actorId: actor.sub });
  }

  // ---------------------------------------------------------------------------
  // Social verification — SUPER_ADMIN only.
  // ---------------------------------------------------------------------------

  @Roles(Role.SUPER_ADMIN)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post(":id/social/verify")
  @HttpCode(HttpStatus.OK)
  async markSocialVerified(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(verifySocialSchema)) body: VerifySocialInput,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.vendors.markSocialVerified(id, { actorId: actor.sub, notes: body.notes });
  }
}
