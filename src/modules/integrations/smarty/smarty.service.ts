/**
 * SmartyService — address validation adapter.
 *
 * Implementation Plan §6.6.1.
 *
 * v1: STUB. The shape is final; we plug in the SmartyStreets US Street API
 * later by swapping the body of `verifyUS()`. Until then, the stub does
 * format-only validation and returns ACCEPTED for plausibly-shaped US
 * addresses, NEEDS_VERIFICATION for thin/odd ones, and REJECTED for blank.
 *
 * The contract:
 *   ACCEPTED            — shippable; carrier will accept it.
 *   NEEDS_VERIFICATION  — looks usable but Smarty wants a confirmation step;
 *                          UI should surface a "did you mean…" prompt.
 *   REJECTED            — clearly bad; service refuses to create the order.
 */

import { Injectable, Logger } from "@nestjs/common";

export type SmartyOutcome = "ACCEPTED" | "NEEDS_VERIFICATION" | "REJECTED";

export interface AddressInput {
  line1: string;
  line2?: string | undefined;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}

export interface AddressValidationResult {
  outcome: SmartyOutcome;
  /** Provider-suggested normalized form (e.g. ZIP+4). Optional. */
  normalized?: AddressInput;
  /** Free-form provider note for the audit log / UI. */
  detail?: string;
  /** Provider correlation id for support tickets. */
  providerRef?: string;
}

const US_STATES = new Set([
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD",
  "MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC",
  "SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","DC","PR","VI","GU","AS","MP",
]);

const US_ZIP_RE = /^\d{5}(-\d{4})?$/;

@Injectable()
export class SmartyService {
  private readonly log = new Logger(SmartyService.name);

  async verifyUS(addr: AddressInput): Promise<AddressValidationResult> {
    // Defence-in-depth normalization (the schema layer already trimmed).
    const line1 = addr.line1.trim();
    const city = addr.city.trim();
    const state = addr.state.trim().toUpperCase();
    const postalCode = addr.postalCode.trim().toUpperCase();
    const country = addr.country.trim().toUpperCase();

    if (country !== "US") {
      // Out-of-scope for v1 (we only ship domestic USA in P3).
      return {
        outcome: "REJECTED",
        detail: "International shipping is not supported in v1.",
      };
    }
    if (!line1 || !city) {
      return { outcome: "REJECTED", detail: "Missing street or city." };
    }
    if (!US_STATES.has(state)) {
      return { outcome: "REJECTED", detail: `Unknown US state code: ${state}` };
    }
    if (!US_ZIP_RE.test(postalCode)) {
      return { outcome: "REJECTED", detail: "ZIP must be 5 digits or ZIP+4." };
    }

    // Heuristic: PO boxes need verification (some carriers refuse them).
    if (/\bP\.?\s*O\.?\s*BOX\b/i.test(line1)) {
      return {
        outcome: "NEEDS_VERIFICATION",
        detail: "PO Box detected. Some services (e.g. UPS) will refuse delivery.",
        normalized: { ...addr, state, postalCode },
      };
    }

    // Stubbed canonicalization: pad ZIP to ZIP+4 placeholder for telemetry.
    return {
      outcome: "ACCEPTED",
      normalized: { ...addr, state, postalCode },
      providerRef: `smarty-stub-${Date.now()}`,
    };
  }
}
