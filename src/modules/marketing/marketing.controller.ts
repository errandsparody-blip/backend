/**
 * Public marketing endpoints. Anonymous, unauthenticated, heavily
 * rate-limited — every route here is reachable by any visitor on the
 * internet without a JWT.
 */

import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Ip,
  Headers,
  Logger,
  Post,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";

import { Public } from "../../common/decorators/public.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import {
  requestPricingGuideSchema,
  type RequestPricingGuideInput,
} from "../../common/schemas/marketing.schema";

import { PricingGuideService } from "./pricing-guide.service";

@Controller({ path: "marketing", version: "1" })
export class MarketingController {
  private readonly logger = new Logger(MarketingController.name);

  constructor(private readonly pricingGuide: PricingGuideService) {}

  /**
   * POST /v1/marketing/pricing-guide
   *
   * Lead-capture form on the public /pricing page. Records the lead +
   * emails the PDF. Always returns 200 with a generic success message
   * (even if the email send fails internally) so a probing attacker
   * can't enumerate which email addresses our system is willing to
   * mail. Internal errors are logged + dashboarded separately.
   *
   * Rate limit: 3 / hour / IP — high enough for a legitimate user who
   * fat-fingered the form, low enough to make a spam loop expensive.
   */
  @Public()
  @Post("pricing-guide")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 3, ttl: 60 * 60 * 1000 } })
  async requestPricingGuide(
    @Body(new ZodValidationPipe(requestPricingGuideSchema))
    body: RequestPricingGuideInput,
    @Ip() ip: string | undefined,
    @Headers("user-agent") userAgent: string | undefined,
  ): Promise<{ ok: true }> {
    try {
      await this.pricingGuide.requestGuide({
        businessName: body.businessName,
        email: body.email,
        country: body.country,
        sourceIp: ip ?? null,
        userAgent: userAgent ?? null,
      });
    } catch (err) {
      // Don't surface internals to the visitor. We still want to know
      // about misconfigurations (e.g., missing PDF on disk) so log
      // structured + let Sentry pick it up.
      this.logger.error(
        { err: (err as Error).message, email: this.redact(body.email) },
        "marketing.pricing_guide.unexpected_error",
      );
    }
    // Unconditional 200 — UX-friendly + non-enumerable.
    return { ok: true };
  }

  private redact(email: string): string {
    const at = email.indexOf("@");
    if (at < 1) return "***";
    return `${email[0]}***@${email.slice(at + 1)}`;
  }
}
