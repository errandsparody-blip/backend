/**
 * StorefrontTaxService — destination-based sales tax for storefront orders
 * (Phase 2 follow-up).
 *
 * OFF by default: the rate map (`storefront_tax_rates` config, keyed by ship-to
 * US state → basis points) is empty until an operator sets it, so tax is $0
 * everywhere until the marketplace-facilitator decision is made. When enabled,
 * tax = round(taxableBase × rateForState / 10000), taxable base = goods
 * (shipping/fees excluded for MVP). This mechanism lets tax be switched on per
 * state without any code change.
 */
import { BadRequestException, Injectable, Logger } from "@nestjs/common";

import { PrismaService } from "../../common/prisma.service";

export const STOREFRONT_TAX_RATES_KEY = "storefront_tax_rates";
const MAX_BPS = 10_000;

@Injectable()
export class StorefrontTaxService {
  private readonly logger = new Logger(StorefrontTaxService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Map of US state code → tax basis points. Empty when tax is disabled. */
  async loadRates(): Promise<Record<string, number>> {
    try {
      const row = await this.prisma.configuration.findUnique({
        where: { key: STOREFRONT_TAX_RATES_KEY },
      });
      const value = row?.value as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) return {};
      const out: Record<string, number> = {};
      for (const [k, v] of Object.entries(value)) {
        const state = k.toUpperCase();
        if (!/^[A-Z]{2}$/.test(state)) continue;
        const bps = typeof v === "number" ? v : Number(v);
        if (Number.isInteger(bps) && bps >= 0 && bps <= MAX_BPS) out[state] = bps;
      }
      return out;
    } catch (err) {
      this.logger.error({ err: `${err}` }, "storefront.tax_rates_load_failed");
      return {}; // fail safe: no tax rather than blocking checkout
    }
  }

  /** Tax in cents for a ship-to state on a taxable base (rates loaded once). */
  computeTaxCents(
    rates: Record<string, number>,
    stateCode: string,
    taxableBaseCents: number,
  ): number {
    const bps = rates[stateCode?.toUpperCase()] ?? 0;
    if (bps <= 0 || taxableBaseCents <= 0) return 0;
    return Math.round((taxableBaseCents * bps) / 10_000);
  }

  /** Convenience: load + compute in one call. */
  async taxFor(stateCode: string, taxableBaseCents: number): Promise<number> {
    return this.computeTaxCents(await this.loadRates(), stateCode, taxableBaseCents);
  }

  // ---- Admin config ----

  async getRates(): Promise<Record<string, number>> {
    return this.loadRates();
  }

  async setRates(actorId: string, rates: Record<string, number>): Promise<Record<string, number>> {
    const clean: Record<string, number> = {};
    for (const [k, v] of Object.entries(rates)) {
      const state = k.toUpperCase();
      if (!/^[A-Z]{2}$/.test(state)) {
        throw new BadRequestException({ message: `Invalid state code: ${k}`, code: "invalid_state" });
      }
      if (!Number.isInteger(v) || v < 0 || v > MAX_BPS) {
        throw new BadRequestException({ message: `Invalid rate for ${state} (0–10000 bps).`, code: "invalid_rate" });
      }
      clean[state] = v;
    }
    await this.prisma.configuration.upsert({
      where: { key: STOREFRONT_TAX_RATES_KEY },
      create: { key: STOREFRONT_TAX_RATES_KEY, value: clean, updatedBy: actorId },
      update: { value: clean, updatedBy: actorId },
    });
    return clean;
  }
}
