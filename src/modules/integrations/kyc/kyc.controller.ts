/**
 * Inbound KYC webhook endpoint. Public (no JWT) — protected by HMAC signature.
 *
 * Adapter for Stripe Identity payload shape:
 *   { id, type, data: { object: { id, status, metadata: { vendorId } } } }
 *
 * Status mapping:
 *   "verified"        → APPROVED
 *   "requires_input"  → REQUIRES_RESUBMISSION
 *   "canceled"        → REJECTED
 *   "processing"      → IN_PROGRESS  (handled by setKycStatus pre-final state)
 */

import { BadRequestException, Body, Controller, Headers, HttpCode, HttpStatus, Post, Req } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { Request } from "express";

import { loadConfig } from "../../../common/config";
import { Public } from "../../../common/decorators/public.decorator";

import { KycService, type NormalizedKycOutcome } from "./kyc.service";

interface StripeIdentityWebhook {
  id?: string;
  type?: string;
  data?: {
    object?: {
      id?: string;
      status?: "verified" | "requires_input" | "processing" | "canceled";
      metadata?: { vendorId?: string };
    };
  };
}

@Controller({ path: "webhooks/kyc", version: "1" })
export class KycController {
  constructor(private readonly kyc: KycService) {}

  @Public()
  @Post()
  @HttpCode(HttpStatus.OK)
  // Defence: a forged or replayed flood must not be able to keep CPU busy on
  // signature verification.
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  async handle(
    @Headers("stripe-signature") signature: string | undefined,
    @Req() req: Request & { rawBody?: Buffer },
    @Body() body: StripeIdentityWebhook,
  ): Promise<{ ok: true }> {
    // Verify the signature against the raw body — JSON-serialize would change bytes.
    const raw = req.rawBody ?? Buffer.from(JSON.stringify(body));
    const secret = process.env.KYC_WEBHOOK_SECRET ?? "";
    if (!secret) {
      // In development, allow unsigned webhooks for ergonomics — but never in prod.
      const cfg = loadConfig();
      if (cfg.NODE_ENV === "production") {
        throw new BadRequestException("KYC_WEBHOOK_SECRET is not configured.");
      }
    } else {
      this.kyc.verifySignature(raw, signature, secret);
    }

    const eventId = body.id;
    const sessionId = body.data?.object?.id;
    const status = body.data?.object?.status;
    const vendorId = body.data?.object?.metadata?.vendorId;

    if (!eventId || !sessionId || !status || !vendorId) {
      throw new BadRequestException({
        message: "Webhook payload missing required fields.",
        code: "kyc_payload_invalid",
      });
    }

    const outcome: NormalizedKycOutcome =
      status === "verified" ? "verified" : status === "requires_input" ? "requires_input" : status === "canceled" ? "rejected" : "requires_input";

    await this.kyc.applyOutcome({
      eventId,
      vendorId,
      providerSessionId: sessionId,
      outcome,
    });

    return { ok: true };
  }
}
