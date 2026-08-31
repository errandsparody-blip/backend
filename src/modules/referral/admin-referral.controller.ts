/**
 * AdminReferralController — ops view of the referral program.
 *
 *   GET  /v1/admin/referrals?campaign=CODE   — all referrals (optionally by event)
 *   GET  /v1/admin/referrals/campaigns       — campaigns + signup counts
 *   POST /v1/admin/referrals/campaigns       — create an event campaign
 *   POST /v1/admin/referrals/campaigns/:id/activate
 *   POST /v1/admin/referrals/campaigns/:id/deactivate
 */

import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from "@nestjs/common";
import { Role } from "@prisma/client";
import { z } from "zod";

import { Roles } from "../../common/decorators/roles.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";

import { ReferralService } from "./referral.service";

const ROLE_ADMIN = "ADMIN" as Role;

const createCampaignSchema = z.object({
  code: z.string().trim().min(2).max(40).regex(/^[A-Za-z0-9_-]+$/, "Use letters, digits, - or _."),
  name: z.string().trim().min(2).max(120),
  // Reward per side, in dollars → converted to cents. Default $50.
  rewardDollars: z.coerce.number().min(0).max(100000).optional(),
});
type CreateCampaignInput = z.infer<typeof createCampaignSchema>;

@Controller({ path: "admin/referrals", version: "1" })
@Roles(Role.SUPER_ADMIN, Role.FINANCE_ADMIN, ROLE_ADMIN)
export class AdminReferralController {
  constructor(private readonly referrals: ReferralService) {}

  @Get()
  list(@Query("campaign") campaign?: string) {
    return this.referrals.adminList(campaign).then((items) => ({ items }));
  }

  @Get("campaigns")
  campaigns() {
    return this.referrals.listCampaigns().then((items) => ({ items }));
  }

  @Post("campaigns")
  createCampaign(@Body(new ZodValidationPipe(createCampaignSchema)) body: CreateCampaignInput) {
    return this.referrals.createCampaign({
      code: body.code,
      name: body.name,
      rewardCents: body.rewardDollars !== undefined ? Math.round(body.rewardDollars * 100) : undefined,
    });
  }

  @Post("campaigns/:id/activate")
  activate(@Param("id", new ParseUUIDPipe()) id: string) {
    return this.referrals.setCampaignActive(id, true).then(() => ({ ok: true }));
  }

  @Post("campaigns/:id/deactivate")
  deactivate(@Param("id", new ParseUUIDPipe()) id: string) {
    return this.referrals.setCampaignActive(id, false).then(() => ({ ok: true }));
  }
}
