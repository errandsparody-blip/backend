/**
 * EasyPostService — shipping rate / label / tracking adapter.
 *
 * Implementation Plan §6.6.2.
 *
 * v1: STUB. The shape mirrors EasyPost's REST shape so the production swap
 * is a one-line change. The stub returns deterministic synthetic rates so
 * downstream code (OrderService quote → create) can be exercised without a
 * live key.
 *
 * IMPORTANT: when this class is wired to the real API, every external call
 * must:
 *   - time out after 5s
 *   - retry idempotently on 5xx (2x with exponential backoff)
 *   - never persist the API key in logs (use the redact list in app.module)
 *   - record the EasyPost shipment id + rate id on the Order row so we can
 *     prove what the carrier was paid.
 */

import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { createHmac, timingSafeEqual } from "node:crypto";

import { loadConfig } from "../../../common/config";

export interface RateRequestParcel {
  weightOz: number;
  lengthIn: number;
  widthIn: number;
  heightIn: number;
}

export interface RateRequest {
  fromAddress: { state: string; postalCode: string; country: string };
  toAddress: {
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
  carrier: string;
  service: string;
  estimatedDeliveryDays: number;
  costCents: number;          // what the carrier charges us
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

@Injectable()
export class EasyPostService {
  private readonly log = new Logger(EasyPostService.name);

  // ---------------------------------------------------------------------------
  // Rates
  // ---------------------------------------------------------------------------

  async getRates(req: RateRequest): Promise<RateResponse> {
    if (req.parcel.weightOz <= 0) {
      throw new BadRequestException("Parcel weight must be positive.");
    }
    if (req.toAddress.country !== "US" || req.fromAddress.country !== "US") {
      throw new BadRequestException("v1 supports US domestic only.");
    }

    // Synthetic deterministic rates — based on weight / dimensions.
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
        carrier: "USPS",
        service: "Priority",
        estimatedDeliveryDays: 3,
        costCents: baseUSPS,
      },
      {
        rateId: `rate_stub_ups_ground_${shipmentId}`,
        carrier: "UPS",
        service: "Ground",
        estimatedDeliveryDays: 4,
        costCents: baseUPS,
      },
      {
        rateId: `rate_stub_fedex_home_${shipmentId}`,
        carrier: "FedEx",
        service: "Home Delivery",
        estimatedDeliveryDays: 5,
        costCents: baseFedEx,
      },
    ];

    this.log.debug({ msg: "getRates (stub)", to: req.toAddress.postalCode, billingWeight, count: rates.length });
    return { shipmentId, rates };
  }

  // ---------------------------------------------------------------------------
  // Purchase a label
  // ---------------------------------------------------------------------------

  async purchaseLabel(req: PurchaseLabelRequest): Promise<LabelResponse> {
    // Synthesize a tracking number that looks like USPS for the stub.
    const tracking = `9400${Math.floor(Math.random() * 1e16)
      .toString()
      .padStart(16, "0")}`;
    return {
      trackingNumber: tracking,
      labelUrl: `https://stub.easypost.local/labels/${req.shipmentId}.pdf`,
      carrier: req.rateId.includes("usps") ? "USPS" : req.rateId.includes("ups") ? "UPS" : "FedEx",
      service: "Stub Service",
      costCents: 0, // The real cost was already captured at rate selection time.
    };
  }

  // ---------------------------------------------------------------------------
  // Tracking webhook signature verification.
  //
  // EasyPost emits the HMAC-SHA256 of the raw request body, hex-encoded, in
  // the `X-Hmac-Signature` header (lowercase form supported by Node's
  // headers-as-incoming-message). We compare with `timingSafeEqual` so a
  // forged signature can't be discovered by side-channel timing.
  //
  // Behaviour:
  //   - production              — secret REQUIRED (Zod superRefine asserts).
  //   - dev/test, no secret set — accept the request (ergonomic), log a warn.
  //   - dev/test, secret set    — verify like prod (so tests can exercise it).
  // ---------------------------------------------------------------------------

  verifyWebhookSignature(rawBody: string, signatureHeader: string | undefined): boolean {
    const cfg = loadConfig();
    const secret = cfg.EASYPOST_WEBHOOK_SECRET;
    if (!secret) {
      // Production rejected at boot time by the config superRefine. In dev we
      // allow the request through but make the soft fail visible.
      this.log.warn("EASYPOST_WEBHOOK_SECRET not set — accepting webhook unverified (dev only)");
      return true;
    }
    if (!signatureHeader || typeof signatureHeader !== "string") {
      return false;
    }

    // EasyPost may emit the value with a "sha256=" prefix or as a bare hex.
    // Tolerate both — strip a leading prefix if present.
    const presented = signatureHeader.replace(/^sha256=/i, "").trim();
    if (!/^[0-9a-fA-F]{64}$/.test(presented)) {
      return false;
    }

    const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");

    // timingSafeEqual demands matching lengths; the regex above guarantees 64.
    const a = Buffer.from(presented.toLowerCase(), "hex");
    const b = Buffer.from(expected, "hex");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }
}
