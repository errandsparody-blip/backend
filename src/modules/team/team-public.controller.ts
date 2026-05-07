/**
 * Public invitation-accept endpoint.
 *
 *   POST /v1/auth/invitations/accept
 *
 * Public (no JWT). Verifies the single-use token, creates the User row
 * pre-verified, marks the invitation ACCEPTED. The recipient must enrol MFA
 * on first login like any other vendor user.
 *
 * Throttle: 10/min per IP. Slow brute-force protection is also provided by
 * the 24-hour TTL + opaque token.
 */

import { Body, Controller, HttpCode, HttpStatus, Post } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";

import { Public } from "../../common/decorators/public.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import {
  acceptInvitationSchema,
  type AcceptInvitationInput,
} from "../../common/schemas/team.schema";

import { TeamService } from "./team.service";

@Controller({ path: "auth/invitations", version: "1" })
export class TeamPublicController {
  constructor(private readonly team: TeamService) {}

  @Public()
  @Post("accept")
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async accept(
    @Body(new ZodValidationPipe(acceptInvitationSchema)) body: AcceptInvitationInput,
  ) {
    const { userId, email } = await this.team.acceptInvitation(body.token, body.password);
    return { userId, email };
  }
}
