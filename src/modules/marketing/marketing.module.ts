/**
 * MarketingModule — public, unauthenticated marketing endpoints.
 *
 * Currently hosts only the pricing-guide lead-capture flow. As more
 * top-of-funnel surfaces land (waitlists, beta sign-ups, etc.) they'd
 * register here.
 */

import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";
import { EmailModule } from "../email/email.module";

import { MarketingController } from "./marketing.controller";
import { PricingGuideService } from "./pricing-guide.service";

@Module({
  imports: [AuditModule, EmailModule],
  controllers: [MarketingController],
  providers: [PricingGuideService],
})
export class MarketingModule {}
