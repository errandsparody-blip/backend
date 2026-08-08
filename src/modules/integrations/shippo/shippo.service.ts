/**
 * ShippoService — shipping rate / label / tracking adapter.
 *
 * Implementation Plan §6.6.2. Replaces the earlier EasyPost integration.
 *
 * Behaviour split by environment:
 *
 *   - SHIPPO_API_KEY set        → real REST client against api.goshippo.com
 *   - SHIPPO_API_KEY unset      → deterministic stub (synthetic rates +
 *                                 fake tracking numbers). Local dev only;
 *                                 blocked in production by the config
 *                                 superRefine.
 *
 * Why a self-built client rather than the `shippo` npm package?
 *   - Native fetch + AbortController gives us a tight 8s timeout that the
 *     SDK doesn't expose cleanly.
 *   - One fewer 3rd-party in the supply chain — Snyk surface area shrinks.
 *   - The REST shape is stable across minor versions of the API.
 *
 * Why Shippo over EasyPost: simpler test-token flow (no business
 * verification required for sandbox), straightforward dashboard, and the
 * REST surface area is friendlier for the operations we need (rates →
 * transactions → tracking).
 *
 * Security non-negotiables (CLAUDE.md):
 *   - API key never appears in logs (we log destination metadata only).
 *   - Webhook secret first-pass check happens at the controller (path-
 *     query token, constant-time compare). Defense-in-depth via
 *     callback verification (`getTracker`) is the controller's job.
 *   - 4xx errors do NOT retry (could double-charge); 5xx errors retry
 *     twice with bounded jitter.
 *   - Outbound timeouts bounded at 8s by default.
 *   - PII (addresses) sent to Shippo over TLS, never logged here.
 */

import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { timingSafeEqual } from "node:crypto";

import { parseUsAddress } from "../../../common/address-parse";
import { loadConfig } from "../../../common/config";

// =============================================================================
// Public types — kept identical to the previous EasyPost adapter so callers
// (OrderService, AdminOrderService, ReturnService) don't need re-wiring.
// All money is integer cents at this boundary.
// =============================================================================

export interface RateRequestParcel {
  weightOz: number;
  lengthIn: number;
  widthIn: number;
  heightIn: number;
  /**
   * Migration 0049 / Phase N — Shippo parcel-template id. When set,
   * Shippo returns flat-rate / one-rate / simple-rate pricing for that
   * container instead of weight-based pricing. Values come from
   * CarrierPackagingRegistryService or from a library preset's
   * shippo_template column. Undefined = plain weight-based parcel
   * (existing behaviour).
   */
  template?: string | undefined;
}

export interface RateRequest {
  fromAddress: { state: string; postalCode: string; country: string };
  toAddress: {
    /** Recipient name printed on the label. Falls back to a placeholder if absent. */
    recipientName?: string | undefined;
    line1: string;
    line2?: string | undefined;
    city: string;
    state: string;
    postalCode: string;
    country: string;
  };
  parcel: RateRequestParcel;
  /** Total declared value in cents — informs insurance / customs (US-only v1). */
  declaredValueCents: number;
  insuranceRequested: boolean;
}

export interface ShippingRate {
  /** Provider rate id — used to purchase a label. */
  rateId: string;
  /**
   * Provider shipment id this rate belongs to. Usually the base shipment,
   * but flat-rate options come from their own per-container shipments, so
   * each rate carries its own id for the later label purchase.
   */
  shipmentId: string;
  carrier: string;
  service: string;
  estimatedDeliveryDays: number;
  costCents: number;
}

/**
 * USPS Priority Mail Flat Rate containers. Flat rate is only offered when
 * the parcel demonstrably fits one of these AND weighs ≤ 70 lb — otherwise
 * the goods aren't flat-rate eligible and we show weight-based rates only.
 *
 * `interiorIn` is the usable interior (sorted ascending at compare time so
 * the parcel may be rotated). The envelope is modelled as a shallow box.
 * Tokens are Shippo's USPS flat-rate parcel templates.
 */
interface FlatRateContainer {
  template: string;
  /** Buyer-facing box name, e.g. "Medium Box". */
  label: string;
  interiorIn: [number, number, number];
}
const FLAT_RATE_MAX_WEIGHT_OZ = 70 * 16; // USPS flat-rate cap: 70 lb.
const FLAT_RATE_CONTAINERS: ReadonlyArray<FlatRateContainer> = [
  { template: "USPS_FlatRateEnvelope", label: "Envelope", interiorIn: [12.5, 9.5, 0.75] },
  { template: "USPS_SmallFlatRateBox", label: "Small Box", interiorIn: [8.625, 5.375, 1.625] },
  { template: "USPS_MediumFlatRateBox1", label: "Medium Box", interiorIn: [11, 8.5, 5.5] },
  { template: "USPS_LargeFlatRateBox", label: "Large Box", interiorIn: [12, 12, 5.5] },
];

/**
 * Which flat-rate containers a parcel qualifies for. A parcel qualifies only
 * when (a) all three dimensions are known/measured, (b) total weight is at or
 * under the 70 lb cap, and (c) it physically fits the container with rotation
 * allowed. Unknown dimensions return `[]` — we never offer a flat-rate box we
 * can't prove the goods fit into.
 */
export function eligibleFlatRateContainers(parcel: {
  weightOz: number;
  lengthIn: number;
  widthIn: number;
  heightIn: number;
}): ReadonlyArray<FlatRateContainer> {
  const dims = [parcel.lengthIn, parcel.widthIn, parcel.heightIn];
  if (dims.some((d) => !(d > 0))) return []; // dimensions unknown → can't prove fit
  if (parcel.weightOz > FLAT_RATE_MAX_WEIGHT_OZ) return [];
  const sortedParcel = [...dims].sort((a, b) => a - b);
  return FLAT_RATE_CONTAINERS.filter((c) => {
    const sortedBox = [...c.interiorIn].sort((a, b) => a - b);
    return sortedParcel.every((d, i) => d <= sortedBox[i]!);
  });
}

export interface RateResponse {
  /** Provider shipment id — held on the Order so we can purchase later. */
  shipmentId: string;
  rates: ShippingRate[];
}

export interface PurchaseLabelRequest {
  shipmentId: string;
  rateId: string;
  insuranceCents?: number;
}

export interface LabelResponse {
  trackingNumber: string;
  labelUrl: string;
  carrier: string;
  service: string;
  costCents: number;
}

/**
 * Verified tracker payload returned by `getTracker`. The webhook controller
 * uses this as the authoritative source of truth — never trusting the
 * incoming webhook body's claimed status.
 */
export interface TrackerSnapshot {
  carrier: string;
  trackingNumber: string;
  /** Canonical Shippo status, lowercased: "pre_transit" / "transit" / "delivered" / "returned" / "failure" / "unknown". */
  status: string;
  statusDetail: string | null;
  /** ISO 8601 string from the carrier, or null if not provided. */
  statusDate: string | null;
}

// ---------------------------------------------------------------------------
// Address validation
// ---------------------------------------------------------------------------

export interface AddressValidationRequest {
  line1: string;
  line2?: string | undefined;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}

export interface AddressValidationOutcome {
  /**
   * "valid" — USPS/carrier database confirmed deliverable.
   * "needs_verification" — plausible but Shippo wants the vendor to confirm
   *                        (e.g. PO box, rural route, ambiguous unit).
   * "invalid" — USPS does not recognise this address.
   */
  outcome: "valid" | "needs_verification" | "invalid";
  /** Free-form provider note for the audit log + UI. */
  detail: string | null;
  /**
   * USPS-canonical form of the address (e.g. fixed casing, ZIP+4 added).
   * Returned even when outcome is "needs_verification" so the UI can show
   * a "Did you mean…?" prompt.
   */
  corrected: AddressValidationRequest | null;
  /** Shippo's address object id — useful for support tickets. */
  providerRef: string | null;
}

/** Structured address fields parsed from a single free-text string. */
export interface ParsedAddress {
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  phone: string | null;
}

// =============================================================================
// Shippo REST response shapes — narrow types covering only the fields we
// consume. Shippo adds new fields over time; keeping the surface small means
// new fields never break our code.
// =============================================================================

interface ShRate {
  object_id: string;
  provider: string;
  servicelevel?: { name?: string; token?: string };
  amount: string; // USD string, e.g. "8.40"
  currency?: string;
  estimated_days?: number | null;
}

interface ShShipment {
  object_id: string;
  rates?: ShRate[];
  messages?: Array<{ source?: string; code?: string; text?: string }>;
}

interface ShTransaction {
  object_id: string;
  /** "SUCCESS" | "QUEUED" | "ERROR" | "WAITING". */
  status: string;
  tracking_number?: string | null;
  label_url?: string | null;
  rate?: string | null; // rate object id (we resolve carrier/service from selected_rate when available)
  selected_rate?: ShRate | null;
  carrier?: string | null;
  servicelevel?: { name?: string } | null;
  messages?: Array<{ source?: string; code?: string; text?: string }>;
}

interface ShTrackingStatus {
  status?: string;
  status_details?: string | null;
  status_date?: string | null;
}

interface ShTrack {
  carrier?: string;
  tracking_number?: string;
  tracking_status?: ShTrackingStatus | null;
}

interface ShAddressValidationMessage {
  source?: string;
  code?: string;
  type?: string;
  text?: string;
}

interface ShAddressValidationResults {
  is_valid?: boolean;
  messages?: ShAddressValidationMessage[];
}

interface ShAddress {
  object_id?: string;
  /** "VALID" | "INVALID" | "UNKNOWN" — Shippo's canonical status. */
  object_state?: string;
  is_complete?: boolean;
  validation_results?: ShAddressValidationResults | null;
  /** USPS-canonical address (returned in the same response when valid). */
  name?: string | null;
  street1?: string;
  street2?: string | null;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
}

/** Raw response from Shippo's v2 address parser (GET /v2/addresses/parse). */
interface ShParsedAddress {
  address_line_1?: string;
  address_line_2?: string;
  city_locality?: string;
  state_province?: string;
  postal_code?: string;
  country_code?: string;
  phone?: string;
  email?: string;
}

// =============================================================================

@Injectable()
export class ShippoService {
  private readonly log = new Logger(ShippoService.name);
  private readonly cfg = loadConfig();
  private readonly baseUrl = "https://api.goshippo.com";
  /**
   * Pin the API version so Shippo can roll out breaking changes without
   * silently changing our payload shape. 2018-02-08 is their long-lived
   * stable major; bump deliberately when we've validated the new fields.
   */
  private readonly apiVersion = "2018-02-08";

  /** True when SHIPPO_API_KEY is set. Used by diagnostics / tests. */
  isLive(): boolean {
    return Boolean(this.cfg.SHIPPO_API_KEY);
  }

  // ===========================================================================
  // Rates
  // ===========================================================================

  async getRates(req: RateRequest): Promise<RateResponse> {
    this.validateRateRequest(req);
    return this.isLive() ? this.getRatesLive(req) : this.getRatesStub(req);
  }

  private async getRatesLive(req: RateRequest): Promise<RateResponse> {
    // Shippo accepts weight in oz with up to 4-decimal precision; we round
    // to 0.1 so logging matches what carriers see on the label.
    const weightOz = Math.round(req.parcel.weightOz * 10) / 10;

    // Shippo's REST API requires positive dimensions. Our products allow
    // null dimensions (weight-only listings), which the parcel aggregator
    // emits as zeros. Substitute a 1-inch minimum so the carrier can still
    // produce rates from weight; the resulting envelope is "smallest
    // possible," which is the right semantic for a flat-pack / soft-good
    // listing without measured dimensions.
    const lengthIn = req.parcel.lengthIn > 0 ? req.parcel.lengthIn : 1;
    const widthIn = req.parcel.widthIn > 0 ? req.parcel.widthIn : 1;
    const heightIn = req.parcel.heightIn > 0 ? req.parcel.heightIn : 1;

    // Shippo creates the to_address + from_address inline as part of the
    // shipment payload. We pass them as objects rather than ID refs to
    // avoid the extra round-trip needed to pre-create address records.
    // Held in locals so the flat-rate shipments below can reuse them.
    const addressFrom = {
      name: this.cfg.WAREHOUSE_FROM_NAME,
      street1: this.cfg.WAREHOUSE_FROM_STREET1,
      street2: this.cfg.WAREHOUSE_FROM_STREET2 ?? "",
      city: this.cfg.WAREHOUSE_FROM_CITY,
      state: this.cfg.WAREHOUSE_FROM_STATE,
      zip: this.cfg.WAREHOUSE_FROM_ZIP,
      country: "US",
      phone: this.cfg.WAREHOUSE_FROM_PHONE,
      // USPS rejects label purchase without sender email. See config.ts.
      email: this.cfg.WAREHOUSE_FROM_EMAIL,
    };
    const addressTo = {
      // Recipient name as printed on the label. Trim and fall back to a
      // placeholder only if the caller genuinely has no name on file —
      // an empty string here would make USPS reject the label.
      name: req.toAddress.recipientName?.trim() || "Recipient",
      street1: req.toAddress.line1,
      street2: req.toAddress.line2 ?? "",
      city: req.toAddress.city,
      state: req.toAddress.state,
      zip: req.toAddress.postalCode,
      country: req.toAddress.country,
    };
    // Migration 0049 / Phase N — carrier template. When set, Shippo
    // returns flat-rate / one-rate / simple-rate pricing for that
    // container. Shippo accepts either a `template` id OR raw dims;
    // when both are sent, the template's canonical dims take priority
    // and the passed dims are informational. We send both so the
    // dashboard's transactions view shows the physical parcel size.
    const parcel: Record<string, string> = {
      length: lengthIn.toString(),
      width: widthIn.toString(),
      height: heightIn.toString(),
      distance_unit: "in",
      weight: weightOz.toString(),
      mass_unit: "oz",
    };
    if (req.parcel.template) {
      parcel.template = req.parcel.template;
    }
    const body = {
      address_from: addressFrom,
      address_to: addressTo,
      parcels: [parcel],
      async: false,
    };

    const ship = await this.request<ShShipment>("POST", "/shipments/", body);
    if (!ship.rates || ship.rates.length === 0) {
      const reasons = (ship.messages ?? [])
        .filter((m) => m.text)
        .map((m) => `${m.source ?? "?"}: ${m.text ?? ""}`)
        .slice(0, 4)
        .join(" / ");
      throw new BadRequestException({
        code: "shippo_no_rates",
        message: `No shipping rates returned${reasons ? ` — ${reasons}` : ""}.`,
      });
    }

    const rates: ShippingRate[] = ship.rates.map((r) => ({
      rateId: r.object_id,
      shipmentId: ship.object_id,
      carrier: r.provider,
      service: r.servicelevel?.name ?? r.servicelevel?.token ?? "Standard",
      estimatedDeliveryDays: this.normalizeDeliveryDays(r.estimated_days),
      costCents: this.dollarsToCents(r.amount),
    }));

    // Flat-rate options live in their own per-container shipments (a Shippo
    // shipment prices exactly one parcel). Fetch them in parallel and merge.
    // Failures here must never sink the base quote — flat rate is additive.
    const flatRates = await this.getFlatRateOptions(req, addressFrom, addressTo);

    this.log.debug({
      msg: "getRates",
      shipmentId: ship.object_id,
      toState: req.toAddress.state,
      toZipPrefix: req.toAddress.postalCode.slice(0, 3),
      count: rates.length,
      flatRateCount: flatRates.length,
    });

    return { shipmentId: ship.object_id, rates: [...rates, ...flatRates] };
  }

  /**
   * Returns USPS Priority Mail Flat Rate options for every container the
   * parcel fits, or `[]` when none qualify (unknown dims, over 70 lb, or
   * nothing fits). Each container is a separate Shippo shipment using its
   * flat-rate template; we keep only the genuinely flat-rate service levels
   * so we don't duplicate the weight-based rates from the base shipment.
   */
  private async getFlatRateOptions(
    req: RateRequest,
    addressFrom: Record<string, string>,
    addressTo: Record<string, string>,
  ): Promise<ShippingRate[]> {
    const eligible = eligibleFlatRateContainers(req.parcel);
    if (eligible.length === 0) return [];

    const weightOz = Math.max(1, Math.round(req.parcel.weightOz));
    const perContainer = await Promise.all(
      eligible.map(async (c) => {
        try {
          const ship = await this.request<ShShipment>("POST", "/shipments/", {
            address_from: addressFrom,
            address_to: addressTo,
            // A flat-rate template replaces explicit dimensions — USPS prices
            // by the box, not by size, as long as weight stays under the cap.
            parcels: [{ template: c.template, weight: weightOz.toString(), mass_unit: "oz" }],
            async: false,
          });
          // Shippo prices a flat-rate box under the standard "Priority Mail"
          // service (token `usps_priority`) — the service NAME does not say
          // "flat rate", so we must match the service, not a label. Keep only
          // Priority Mail (the flat-rate-bearing service) to avoid duplicating
          // the weight-based rates the base shipment already returned, then
          // relabel with the box name so the buyer sees which container it is.
          return (ship.rates ?? [])
            .filter((r) => {
              const token = (r.servicelevel?.token ?? "").toLowerCase();
              const name = (r.servicelevel?.name ?? "").toLowerCase();
              return (
                token === "usps_priority" ||
                name === "priority mail" ||
                name.includes("flat rate")
              );
            })
            .map<ShippingRate>((r) => ({
              rateId: r.object_id,
              shipmentId: ship.object_id,
              carrier: r.provider,
              service: `Priority Mail Flat Rate · ${c.label}`,
              estimatedDeliveryDays: this.normalizeDeliveryDays(r.estimated_days),
              costCents: this.dollarsToCents(r.amount),
            }));
        } catch (err) {
          this.log.warn({ msg: "flat-rate lookup failed", template: c.template, err: `${err}` });
          return [];
        }
      }),
    );
    return perContainer.flat();
  }

  // ---------------------------------------------------------------------------

  private getRatesStub(req: RateRequest): Promise<RateResponse> {
    const lbs = req.parcel.weightOz / 16;
    const dimWeight = (req.parcel.lengthIn * req.parcel.widthIn * req.parcel.heightIn) / 139;
    const billingWeight = Math.max(lbs, dimWeight);

    const baseUSPS = Math.ceil(750 + billingWeight * 95);
    const baseUPS = Math.ceil(900 + billingWeight * 130);
    const baseFedEx = Math.ceil(950 + billingWeight * 145);

    const shipmentId = `shp_stub_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const rates: ShippingRate[] = [
      {
        rateId: `rate_stub_usps_priority_${shipmentId}`,
        shipmentId,
        carrier: "USPS",
        service: "Priority Mail",
        estimatedDeliveryDays: 3,
        costCents: baseUSPS,
      },
      {
        rateId: `rate_stub_ups_ground_${shipmentId}`,
        shipmentId,
        carrier: "UPS",
        service: "Ground",
        estimatedDeliveryDays: 4,
        costCents: baseUPS,
      },
      {
        rateId: `rate_stub_fedex_home_${shipmentId}`,
        shipmentId,
        carrier: "FedEx",
        service: "Home Delivery",
        estimatedDeliveryDays: 5,
        costCents: baseFedEx,
      },
    ];

    // Mirror the live path: surface flat-rate options for every container the
    // parcel actually fits, so the dev/test quote view matches production.
    const FLAT_RATE_STUB_CENTS: Record<string, { service: string; cents: number }> = {
      USPS_FlatRateEnvelope: { service: "Priority Mail Flat Rate Envelope", cents: 1010 },
      USPS_SmallFlatRateBox: { service: "Priority Mail Flat Rate Small Box", cents: 1065 },
      USPS_MediumFlatRateBox1: { service: "Priority Mail Flat Rate Medium Box", cents: 1810 },
      USPS_LargeFlatRateBox: { service: "Priority Mail Flat Rate Large Box", cents: 2395 },
    };
    for (const c of eligibleFlatRateContainers(req.parcel)) {
      const meta = FLAT_RATE_STUB_CENTS[c.template];
      if (!meta) continue;
      rates.push({
        rateId: `rate_stub_${c.template.toLowerCase()}_${shipmentId}`,
        shipmentId,
        carrier: "USPS",
        service: meta.service,
        estimatedDeliveryDays: 3,
        costCents: meta.cents,
      });
    }

    this.log.debug({
      msg: "getRates (stub)",
      toZipPrefix: req.toAddress.postalCode.slice(0, 3),
      billingWeight,
      count: rates.length,
    });
    return Promise.resolve({ shipmentId, rates });
  }

  // ===========================================================================
  // Purchase a label
  // ===========================================================================

  async purchaseLabel(req: PurchaseLabelRequest): Promise<LabelResponse> {
    if (!req.shipmentId || !req.rateId) {
      throw new BadRequestException({
        code: "shippo_invalid_purchase",
        message: "shipmentId and rateId are required to purchase a label.",
      });
    }
    return this.isLive() ? this.purchaseLabelLive(req) : this.purchaseLabelStub(req);
  }

  private async purchaseLabelLive(req: PurchaseLabelRequest): Promise<LabelResponse> {
    // Shippo's `transactions` endpoint takes the rate id and creates the
    // label synchronously when `async: false`. There's no shipment-level
    // idempotency the way EasyPost provided — we rely on our own webhook
    // dedup + the order's `ratePurchasedRef` to guarantee one charge.
    const body: Record<string, unknown> = {
      rate: req.rateId,
      label_file_type: "PDF",
      async: false,
    };
    // Shippo's insurance API takes an object with amount + currency. Only
    // include when the caller asked for it AND the amount is non-trivial.
    if (req.insuranceCents && req.insuranceCents > 0) {
      body.insurance = {
        amount: (req.insuranceCents / 100).toFixed(2),
        currency: "USD",
        provider: "FEDEX", // ignored when carrier mismatches; safe sentinel
      };
    }

    const tx = await this.request<ShTransaction>("POST", "/transactions/", body);
    if (tx.status !== "SUCCESS") {
      const reasons = (tx.messages ?? [])
        .filter((m) => m.text)
        .map((m) => `${m.source ?? "?"}: ${m.text ?? ""}`)
        .slice(0, 4)
        .join(" / ");
      this.log.error({
        msg: "purchaseLabel — non-SUCCESS status",
        status: tx.status,
        txId: tx.object_id,
      });
      throw new ServiceUnavailableException({
        code: "shippo_purchase_failed",
        message: reasons || `Label purchase failed (status: ${tx.status}).`,
      });
    }

    const tracking = tx.tracking_number;
    const labelUrl = tx.label_url;
    if (!tracking || !labelUrl) {
      this.log.error({
        msg: "purchaseLabel — incomplete response",
        txId: tx.object_id,
        hasTracking: Boolean(tracking),
        hasLabel: Boolean(labelUrl),
      });
      throw new ServiceUnavailableException({
        code: "shippo_purchase_incomplete",
        message: "Carrier purchase succeeded but tracking or label was missing.",
      });
    }

    // Shippo's `transactions` response in API v2018-02-08 returns `rate`
    // as a string ID, not an expanded object — so `selected_rate` and
    // top-level `carrier` are both undefined here. Without expanding, we'd
    // fall back to "Unknown" and the vendor's shipped-order email would
    // read "Unknown picked it up". Fetch the rate explicitly to get the
    // real carrier + service + amount.
    //
    // Best-effort: if the rate lookup fails (rate id rotated, transient
    // 5xx, etc.) we still return the label — better to ship with imperfect
    // carrier metadata than fail the whole transaction.
    let rateExpanded: ShRate | undefined;
    try {
      rateExpanded = await this.request<ShRate>(
        "GET",
        `/rates/${encodeURIComponent(req.rateId)}`,
      );
    } catch (err) {
      this.log.warn({
        msg: "purchaseLabel — rate expansion failed; falling back to transaction fields",
        rateId: req.rateId,
        err: (err as Error)?.message,
      });
    }

    return {
      trackingNumber: tracking,
      labelUrl,
      carrier:
        rateExpanded?.provider ??
        tx.selected_rate?.provider ??
        tx.carrier ??
        "Unknown",
      service:
        rateExpanded?.servicelevel?.name ??
        rateExpanded?.servicelevel?.token ??
        tx.selected_rate?.servicelevel?.name ??
        tx.servicelevel?.name ??
        "Standard",
      costCents: rateExpanded
        ? this.dollarsToCents(rateExpanded.amount)
        : tx.selected_rate
          ? this.dollarsToCents(tx.selected_rate.amount)
          : 0,
    };
  }

  private purchaseLabelStub(req: PurchaseLabelRequest): Promise<LabelResponse> {
    const tracking = `9400${Math.floor(Math.random() * 1e16)
      .toString()
      .padStart(16, "0")}`;
    return Promise.resolve({
      trackingNumber: tracking,
      labelUrl: `https://stub.shippo.local/labels/${req.shipmentId}.pdf`,
      carrier: req.rateId.includes("usps")
        ? "USPS"
        : req.rateId.includes("ups")
          ? "UPS"
          : "FedEx",
      service: "Stub Service",
      costCents: 0,
    });
  }

  // ===========================================================================
  // Tracker — used by the webhook handler for API callback verification.
  //
  // Shippo doesn't HMAC-sign webhooks. To defend against forged events we
  // make an authenticated GET against /tracks/{carrier}/{tracking_number}
  // and treat the API response as authoritative. Returns null if Shippo
  // doesn't know the tracker — in that case the controller drops the event.
  // ===========================================================================

  async getTracker(carrier: string, trackingNumber: string): Promise<TrackerSnapshot | null> {
    if (!this.isLive()) {
      // In stub mode we fully trust the (test-only) webhook payload — there's
      // no real API to call back against. Tests can override this method.
      return null;
    }
    if (!carrier || !trackingNumber) return null;

    try {
      const t = await this.request<ShTrack>(
        "GET",
        `/tracks/${encodeURIComponent(carrier)}/${encodeURIComponent(trackingNumber)}`,
      );
      const status = t.tracking_status?.status?.toLowerCase() ?? "unknown";
      return {
        carrier: t.carrier ?? carrier,
        trackingNumber: t.tracking_number ?? trackingNumber,
        status,
        statusDetail: t.tracking_status?.status_details ?? null,
        statusDate: t.tracking_status?.status_date ?? null,
      };
    } catch (err) {
      // A 404 means Shippo doesn't recognise the tracker — likely a forged
      // event. We surface this as `null` so the controller can drop the
      // event quietly without raising a 5xx (which would make Shippo retry).
      if (err instanceof BadRequestException) {
        const code = (err.getResponse() as { code?: string }).code;
        if (code === "shippo_not_found") return null;
      }
      throw err;
    }
  }

  // ===========================================================================
  // Address validation
  //
  // Shippo exposes `POST /addresses/` with `validate: true` — same USPS-CASS
  // certified database carriers use later. Catching invalid addresses HERE
  // prevents the worst failure mode in fulfillment: vendor pays, order is
  // ALLOCATED, label can't be purchased because USPS rejects the address.
  //
  // Three outcomes:
  //   - valid              — proceed to order creation.
  //   - needs_verification — UI surfaces a "Did you mean…?" prompt.
  //   - invalid            — block order creation with a structured error.
  // ===========================================================================

  async validateAddress(req: AddressValidationRequest): Promise<AddressValidationOutcome> {
    // Cheap pre-checks that don't burn an API call. Out-of-scope, blank, etc.
    if (req.country.trim().toUpperCase() !== "US") {
      return {
        outcome: "invalid",
        detail: "International shipping is not supported in v1.",
        corrected: null,
        providerRef: null,
      };
    }
    if (!req.line1?.trim() || !req.city?.trim() || !req.state?.trim() || !req.postalCode?.trim()) {
      return {
        outcome: "invalid",
        detail: "Address is missing street, city, state, or ZIP.",
        corrected: null,
        providerRef: null,
      };
    }
    return this.isLive() ? this.validateAddressLive(req) : this.validateAddressStub(req);
  }

  /**
   * Parse a single free-text address string into structured fields via
   * Shippo's v2 address parser (GET /v2/addresses/parse). Best results when
   * the input is comma-delimited in the order: line1, line2, city, state,
   * ZIP, country — but the parser tolerates loose input. Returns blank fields
   * for anything it can't extract so the caller can populate what it got and
   * let the user fill the rest.
   */
  async parseAddress(raw: string): Promise<ParsedAddress> {
    const trimmed = raw.trim();
    if (!trimmed) {
      throw new BadRequestException({
        code: "address_parse_empty",
        message: "Provide an address to parse.",
      });
    }

    // The deterministic local parser is the reliable path — it handles
    // the standard US layouts (incl. "City, ST ZIP" in one segment) with
    // no network dependency. Shippo has no dependable free-text parse
    // endpoint, so it's only an optional enhancement below.
    const local = parseUsAddress(trimmed);
    if (!this.isLive()) return local;

    // If live, try Shippo but only trust it when it actually extracted
    // the essentials; otherwise fall back to the local parse. Any error
    // (including a missing/renamed endpoint) also falls back — the
    // shortcut must never hard-fail the vendor's order form.
    try {
      const parsed = await this.request<ShParsedAddress>(
        "GET",
        `/v2/addresses/parse?address=${encodeURIComponent(trimmed)}`,
      );
      const fromShippo: ParsedAddress = {
        line1: parsed.address_line_1?.trim() ?? "",
        line2: parsed.address_line_2?.trim() || null,
        city: parsed.city_locality?.trim() ?? "",
        state: (parsed.state_province ?? "").trim().toUpperCase(),
        postalCode: parsed.postal_code?.trim() ?? "",
        country: (parsed.country_code ?? "US").trim().toUpperCase() || "US",
        phone: parsed.phone?.trim() || null,
      };
      if (
        fromShippo.line1 &&
        fromShippo.city &&
        fromShippo.state &&
        fromShippo.postalCode
      ) {
        return fromShippo;
      }
      return local;
    } catch {
      return local;
    }
  }

  private async validateAddressLive(req: AddressValidationRequest): Promise<AddressValidationOutcome> {
    const body = {
      // Shippo's address endpoint requires a non-empty name to validate; we
      // pass a placeholder if the caller didn't supply one (the recipient
      // name is gathered separately on our side).
      name: "Recipient",
      street1: req.line1.trim(),
      street2: req.line2?.trim() ?? "",
      city: req.city.trim(),
      state: req.state.trim().toUpperCase(),
      zip: req.postalCode.trim().toUpperCase(),
      country: req.country.trim().toUpperCase(),
      validate: true,
    };

    let resp: ShAddress;
    try {
      resp = await this.request<ShAddress>("POST", "/addresses/", body);
    } catch (err) {
      // A 4xx from Shippo's address endpoint usually means malformed input
      // — surface that to the caller as `invalid` rather than letting the
      // BadRequestException escape and 4xx the vendor's whole order form.
      if (err instanceof BadRequestException) {
        const r = err.getResponse() as { message?: string };
        return {
          outcome: "invalid",
          detail: r.message ?? "Address rejected by validator.",
          corrected: null,
          providerRef: null,
        };
      }
      throw err;
    }

    const isValid = resp.validation_results?.is_valid === true;
    // Shippo's `messages` array carries the validation reasons. Hoist the
    // first text-bearing message for our UI; the full list is logged.
    const messageText = (resp.validation_results?.messages ?? [])
      .map((m) => m.text)
      .filter((t): t is string => Boolean(t))
      .slice(0, 4)
      .join(" / ");

    // The corrected/canonical form Shippo emits is in the same response.
    // We always return it — UI can show "did you mean…" or auto-apply.
    const corrected: AddressValidationRequest = {
      line1: resp.street1 ?? req.line1,
      line2: resp.street2 ?? req.line2,
      city: resp.city ?? req.city,
      state: (resp.state ?? req.state).toUpperCase(),
      postalCode: (resp.zip ?? req.postalCode).toUpperCase(),
      country: (resp.country ?? req.country).toUpperCase(),
    };

    if (!isValid) {
      return {
        outcome: "invalid",
        detail: messageText || "USPS does not recognise this address.",
        corrected,
        providerRef: resp.object_id ?? null,
      };
    }

    // Shippo flags some "VALID but warn me" cases by setting is_valid=true
    // alongside a non-empty messages array (typical for PO boxes, rural
    // routes, missing apartment numbers). Surface those as
    // needs_verification so the UI can prompt before the vendor pays.
    const hasWarnings = (resp.validation_results?.messages ?? []).length > 0;
    if (hasWarnings) {
      return {
        outcome: "needs_verification",
        detail: messageText || "Address is valid but requires confirmation.",
        corrected,
        providerRef: resp.object_id ?? null,
      };
    }

    return {
      outcome: "valid",
      detail: null,
      corrected,
      providerRef: resp.object_id ?? null,
    };
  }

  private validateAddressStub(req: AddressValidationRequest): Promise<AddressValidationOutcome> {
    // Dev stub — preserves enough heuristic checks that local tests don't
    // accidentally exercise the "invalid" path with valid-shaped input.
    // PO box detection runs here because some carriers refuse them and the
    // PRD calls it out as a soft-warn class.
    if (/\bP\.?\s*O\.?\s*BOX\b/i.test(req.line1)) {
      return Promise.resolve({
        outcome: "needs_verification",
        detail: "PO Box detected. Some services (e.g. UPS) refuse delivery.",
        corrected: {
          ...req,
          state: req.state.toUpperCase(),
          postalCode: req.postalCode.toUpperCase(),
        },
        providerRef: `stub-${Date.now()}`,
      });
    }
    return Promise.resolve({
      outcome: "valid",
      detail: null,
      corrected: {
        ...req,
        state: req.state.toUpperCase(),
        postalCode: req.postalCode.toUpperCase(),
      },
      providerRef: `stub-${Date.now()}`,
    });
  }

  // ===========================================================================
  // Webhook path-secret verification.
  //
  // Shippo doesn't HMAC-sign webhooks. The dashboard configuration puts our
  // secret on the URL as a query parameter; the controller pulls it out of
  // the request and asks us to compare. Constant-time so a forged secret
  // can't be discovered via side-channel timing.
  //
  // Behaviour matrix:
  //   - production              — secret REQUIRED at boot (config asserts).
  //   - dev/test, no secret set — accept the request (ergonomic), log a warn.
  //   - dev/test, secret set    — verify like prod (so tests can exercise it).
  // ===========================================================================

  verifyWebhookSecret(presented: string | undefined): boolean {
    const expected = this.cfg.SHIPPO_WEBHOOK_SECRET;
    if (!expected) {
      this.log.warn(
        "SHIPPO_WEBHOOK_SECRET not set — accepting webhook unverified (dev only)",
      );
      return true;
    }
    if (!presented || typeof presented !== "string") return false;
    const a = Buffer.from(presented);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  // ===========================================================================
  // Internals
  // ===========================================================================

  /**
   * Common HTTP path. Shippo authenticates with a custom header scheme:
   *   Authorization: ShippoToken <token>
   * (NOT "Bearer", NOT Basic). The API version pin protects us from breaking
   * changes Shippo rolls out under newer versions.
   */
  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const apiKey = this.cfg.SHIPPO_API_KEY;
    if (!apiKey) {
      throw new ServiceUnavailableException({
        code: "shippo_not_configured",
        message: "Shippo integration is not configured.",
      });
    }

    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `ShippoToken ${apiKey}`,
      "Shippo-API-Version": this.apiVersion,
      Accept: "application/json",
      "User-Agent": "usa-errands-api/1.0 (+https://myusaerrands.com)",
    };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    const MAX_ATTEMPTS = 3;
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.cfg.SHIPPO_TIMEOUT_MS);
      try {
        const res = await fetch(url, { ...init, signal: controller.signal });
        const text = await res.text();
        const json = text ? this.safeParse(text) : {};

        if (res.ok) {
          return json as T;
        }

        // 404 — surfaced separately so getTracker can downgrade to null.
        if (res.status === 404) {
          throw new BadRequestException({
            code: "shippo_not_found",
            message: "Resource not found.",
          });
        }

        // Other 4xx: do not retry. Map to a structured error.
        if (res.status >= 400 && res.status < 500) {
          throw this.mapErrorResponse(res.status, json);
        }

        lastError = new Error(`Shippo ${method} ${path} → ${res.status} ${res.statusText}`);
      } catch (err) {
        if (err instanceof BadRequestException || err instanceof ServiceUnavailableException) {
          throw err;
        }
        lastError = err;
      } finally {
        clearTimeout(timer);
      }

      if (attempt < MAX_ATTEMPTS) {
        const backoffMs = attempt * 250 + Math.floor(Math.random() * 200);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }

    this.log.error({ err: (lastError as Error)?.message, path }, "Shippo request failed");
    throw new ServiceUnavailableException({
      code: "shippo_unavailable",
      message: "Shipping provider is temporarily unavailable. Please try again.",
    });
  }

  private mapErrorResponse(status: number, body: unknown): BadRequestException {
    // Shippo returns error details under various shapes — `detail`, `message`,
    // or a top-level array. Probe in order.
    const b = body as Record<string, unknown> | undefined;
    const message =
      (b && typeof b["detail"] === "string" && (b["detail"] as string)) ||
      (b && typeof b["message"] === "string" && (b["message"] as string)) ||
      `Shippo rejected the request (HTTP ${status}).`;
    return new BadRequestException({ code: "shippo_bad_request", message });
  }

  private safeParse(text: string): unknown {
    try {
      return JSON.parse(text);
    } catch {
      return { detail: text.slice(0, 400) };
    }
  }

  private validateRateRequest(req: RateRequest): void {
    if (req.parcel.weightOz <= 0) {
      throw new BadRequestException({
        code: "shippo_invalid_weight",
        message: "Parcel weight must be positive.",
      });
    }
    // Dimensions are optional on the product side — vendors may not have
    // measured them yet. Reject only NEGATIVE values (clear data error);
    // zero/missing values are substituted with a 1-inch minimum below in
    // getRatesLive so Shippo can still rate from weight alone.
    if (req.parcel.lengthIn < 0 || req.parcel.widthIn < 0 || req.parcel.heightIn < 0) {
      throw new BadRequestException({
        code: "shippo_invalid_parcel",
        message: "Parcel dimensions cannot be negative.",
      });
    }
    if (req.toAddress.country !== "US" || req.fromAddress.country !== "US") {
      throw new BadRequestException({
        code: "shippo_intl_unsupported",
        message: "v1 supports US domestic shipping only.",
      });
    }
  }

  /**
   * Shippo returns rates as USD strings like "8.40". Convert to integer
   * cents without float arithmetic — "8.41" can't be represented exactly as
   * a JS number.
   */
  private dollarsToCents(dollars: string): number {
    const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(dollars.trim());
    if (!m) {
      throw new ServiceUnavailableException({
        code: "shippo_bad_rate",
        message: `Unparseable rate from Shippo: "${dollars}"`,
      });
    }
    const whole = parseInt(m[1] ?? "0", 10);
    const fracStr = (m[2] ?? "").padEnd(2, "0");
    const frac = parseInt(fracStr, 10);
    return whole * 100 + frac;
  }

  private normalizeDeliveryDays(value: number | null | undefined): number {
    // Carriers don't always return a delivery estimate. Fall back to 5
    // (USPS Ground average) rather than throwing.
    return Math.max(1, Math.min(14, value ?? 5));
  }
}
