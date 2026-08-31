/**
 * ReferralController — vendor-facing referral endpoints.
 *
 *   GET /v1/referrals/me — the vendor's referral code, link, and stats.
 */

import { Controller, Get } from "@nestjs/common";
import { Role } from "@prisma/client";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../../common/guards/jwt-auth.guard";

import { ReferralService } from "./referral.service";

@Controller({ path: "referrals", version: "1" })
@Roles(Role.VENDOR, Role.VENDOR_SUB_USER)
export class ReferralController {
  constructor(private readonly referrals: ReferralService) {}

  @Get("me")
  async me(@CurrentUser() user: AuthenticatedUser) {
    return this.referrals.vendorSummary(user.vendorId!);
  }
}
