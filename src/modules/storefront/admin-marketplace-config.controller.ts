/**
 * Super-admin marketplace config (Phase 2 follow-up) — storefront sales-tax
 * rates by ship-to state. Empty = tax disabled.
 *
 *   GET /v1/admin/marketplace/tax-rates
 *   PUT /v1/admin/marketplace/tax-rates   { rates: { "TX": 825, ... } }  (bps)
 */
import { Body, Controller, Get, HttpCode, HttpStatus, Put } from "@nestjs/common";
import { Role } from "@prisma/client";
import { z } from "zod";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../../common/guards/jwt-auth.guard";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";

import { StorefrontTaxService } from "./storefront-tax.service";

const taxRatesSchema = z.object({
  rates: z.record(z.string(), z.number().int().min(0).max(10_000)),
});
type TaxRatesInput = z.infer<typeof taxRatesSchema>;

@Controller({ path: "admin/marketplace/tax-rates", version: "1" })
@Roles(Role.SUPER_ADMIN)
export class AdminMarketplaceConfigController {
  constructor(private readonly tax: StorefrontTaxService) {}

  @Get()
  get() {
    return this.tax.getRates();
  }

  @Put()
  @HttpCode(HttpStatus.OK)
  set(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(taxRatesSchema)) body: TaxRatesInput,
  ) {
    return this.tax.setRates(user.sub, body.rates);
  }
}
