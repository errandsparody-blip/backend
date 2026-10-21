/**
 * Region — the configuration bundle that makes the platform multi-region
 * (UK expansion, Phase 0). A region owns its warehouse origin, currency, and
 * (in later phases) its carriers, address validator, tax engine, fee schedule,
 * and Stripe account. Services resolve a RegionConfig instead of reading the
 * global `WAREHOUSE_FROM_*` env / assuming USD — so adding UK (then CA/EU) is a
 * registry entry, not edits across the order/pack/wallet code (Open/Closed).
 *
 * Phase 0 registers only US (built from today's config), so behaviour is
 * identical. Phase 2 adds the UK entry (GBP, UK origin, UK carriers).
 */

import { loadConfig } from "./config";
import type { Currency } from "./money";

export type RegionCode = "US" | "UK";

export interface RegionAddress {
  name: string;
  street1: string;
  street2?: string;
  city: string;
  state: string;
  postalCode: string;
  /** ISO 3166-1 alpha-2 (e.g. "US", "GB"). */
  country: string;
  phone: string;
  email?: string;
}

export interface RegionConfig {
  code: RegionCode;
  currency: Currency;
  warehouseOrigin: RegionAddress;
  // Added in later phases:
  //   carrierAccountIds: string[];   // Shippo carrier accounts for this region
  //   feeScheduleKey: string;        // which fee_schedule to load
  //   stripeAccountKey: string;      // which Stripe account/keys fund wallets here
}

/**
 * Single source of truth for region configuration. Intended to be provided via
 * DI once services start consuming it; for now it's a plain class so Phase 0
 * stays inert (nothing is wired to it yet).
 */
export class RegionRegistry {
  private readonly byCode = new Map<RegionCode, RegionConfig>();

  constructor() {
    const cfg = loadConfig();
    // US — built from the existing warehouse config. This reproduces today's
    // single-warehouse, USD behaviour exactly.
    this.register({
      code: "US",
      currency: "USD",
      warehouseOrigin: {
        name: cfg.WAREHOUSE_FROM_NAME,
        street1: cfg.WAREHOUSE_FROM_STREET1,
        street2: cfg.WAREHOUSE_FROM_STREET2,
        city: cfg.WAREHOUSE_FROM_CITY,
        state: cfg.WAREHOUSE_FROM_STATE,
        postalCode: cfg.WAREHOUSE_FROM_ZIP,
        country: "US",
        phone: cfg.WAREHOUSE_FROM_PHONE,
        email: cfg.WAREHOUSE_FROM_EMAIL,
      },
    });
    // UK is added in Phase 2 (GBP, UK origin env, UK Shippo carriers).
  }

  private register(config: RegionConfig): void {
    this.byCode.set(config.code, config);
  }

  has(code: RegionCode): boolean {
    return this.byCode.has(code);
  }

  get(code: RegionCode): RegionConfig {
    const config = this.byCode.get(code);
    if (!config) {
      throw new Error(`Region "${code}" is not configured.`);
    }
    return config;
  }

  currencyFor(code: RegionCode): Currency {
    return this.get(code).currency;
  }
}
