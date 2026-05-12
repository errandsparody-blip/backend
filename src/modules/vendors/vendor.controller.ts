import { Body, Controller, ForbiddenException, Get, Patch, Post, UseGuards } from "@nestjs/common";
import { Role } from "@prisma/client";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { TenantGuard } from "../../common/guards/tenant.guard";
import type { AuthenticatedUser } from "../../common/guards/jwt-auth.guard";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import {
  acceptAgreementSchema,
  updateVendorSchema,
  type AcceptAgreementInput,
  type UpdateVendorInput,
} from "../../common/schemas/vendor.schema";

import { VendorService } from "./vendor.service";

@Controller({ path: "vendors/me", version: "1" })
@Roles(Role.VENDOR, Role.VENDOR_SUB_USER)
@UseGuards(TenantGuard)
export class VendorController {
  constructor(private readonly vendors: VendorService) {}

  @Get()
  async me(@CurrentUser() user: AuthenticatedUser) {
    return this.vendors.getProfile(user.vendorId!);
  }

  /**
   * Recurring monthly storage breakdown for the calling vendor. Same
   * math as the billing cron — what you see here is what you'll be
   * charged on the 1st. Sub-users are allowed: they can see what the
   * account will pay, they just can't fund the wallet to cover it.
   */
  @Get("recurring-storage")
  async recurringStorage(@CurrentUser() user: AuthenticatedUser) {
    return this.vendors.getRecurringStorage(user.vendorId!);
  }

  @Patch()
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(updateVendorSchema)) body: UpdateVendorInput,
  ) {
    // Sub-users can read but not edit the vendor profile. The @Roles decorator
    // on the class allows them to GET; we gate the write here so we don't
    // need a separate controller.
    if (user.role === Role.VENDOR_SUB_USER) {
      throw new ForbiddenException({
        message: "Only the vendor admin can edit account settings.",
        code: "vendor_profile_admin_only",
      });
    }
    return this.vendors.updateProfile(user.vendorId!, user.sub, body);
  }

  @Post("agreement")
  async acceptAgreement(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(acceptAgreementSchema)) body: AcceptAgreementInput,
  ) {
    if (user.role === Role.VENDOR_SUB_USER) {
      throw new ForbiddenException({
        message: "Only the vendor admin can accept the agreement.",
        code: "vendor_agreement_admin_only",
      });
    }
    return this.vendors.acceptAgreement(user.vendorId!, user.sub, body.version, body.signatureName);
  }

  /**
   * Vendor self-submits their account for KYC review. Flips kycStatus to
   * IN_PROGRESS so the admin queue picks it up. Sub-users cannot submit —
   * compliance attestation is the vendor admin's responsibility.
   */
  @Post("kyc/submit")
  async submitKyc(@CurrentUser() user: AuthenticatedUser) {
    if (user.role === Role.VENDOR_SUB_USER) {
      throw new ForbiddenException({
        message: "Only the vendor admin can submit KYC.",
        code: "vendor_kyc_admin_only",
      });
    }
    return this.vendors.submitKyc(user.vendorId!, user.sub);
  }
}
