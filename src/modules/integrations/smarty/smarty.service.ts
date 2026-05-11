/**
 * SmartyService — address validation adapter.
 *
 * Implementation Plan §6.6.1.
 *
 * v2: real validation via Shippo's `POST /addresses/` (USPS-CASS certified
 * database). The class name is preserved for backward compatibility with
 * OrderService + tests; internally we delegate to ShippoService so we have
 * a single carrier integration to maintain.
 *
 * The original v1 stub did format-only checks. That stub passed garbage
 * like `line1: "ADE", city: "airport"` because USPS isn't consulted at
 * the format layer — the address only fails at label-purchase time, after
 * the vendor has been charged. That failure mode wasted ledger entries
 * and required manual cleanup. The Shippo-backed implementation catches
 * the bad address BEFORE wallet debit.
 *
 * Contract (unchanged for backward compatibility):
 *   ACCEPTED            — shippable; carrier will accept it.
 *   NEEDS_VERIFICATION  — looks usable but provider wants a confirmation
 *                          step; UI should surface a "did you mean…?" prompt.
 *   REJECTED            — clearly bad; service refuses to create the order.
 */

import { Injectable, Logger } from "@nestjs/common";

import { ShippoService, type AddressValidationOutcome } from "../shippo/shippo.service";

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

@Injectable()
export class SmartyService {
  private readonly log = new Logger(SmartyService.name);

  constructor(private readonly shippo: ShippoService) {}

  /**
   * Verify a US recipient address. Delegates to Shippo's address-validation
   * endpoint and maps its tri-state outcome into the (already-consumed)
   * AddressValidationResult contract.
   */
  async verifyUS(addr: AddressInput): Promise<AddressValidationResult> {
    const sh = await this.shippo.validateAddress({
      line1: addr.line1,
      line2: addr.line2,
      city: addr.city,
      state: addr.state,
      postalCode: addr.postalCode,
      country: addr.country,
    });

    return this.mapOutcome(sh);
  }

  private mapOutcome(sh: AddressValidationOutcome): AddressValidationResult {
    const outcome: SmartyOutcome =
      sh.outcome === "valid"
        ? "ACCEPTED"
        : sh.outcome === "needs_verification"
          ? "NEEDS_VERIFICATION"
          : "REJECTED";

    const result: AddressValidationResult = {
      outcome,
      detail: sh.detail ?? undefined,
      providerRef: sh.providerRef ?? undefined,
    };
    if (sh.corrected) {
      result.normalized = {
        line1: sh.corrected.line1,
        line2: sh.corrected.line2,
        city: sh.corrected.city,
        state: sh.corrected.state,
        postalCode: sh.corrected.postalCode,
        country: sh.corrected.country,
      };
    }

    if (outcome !== "ACCEPTED") {
      this.log.debug({
        msg: "address validation outcome",
        outcome,
        detail: result.detail,
      });
    }
    return result;
  }
}
