/**
 * KycService — handles inbound webhooks from a KYC provider (Stripe Identity
 * by default; provider is configured via env). The handler is idempotent:
 * the same event id processed twice has no additional effect.
 *
 * Implementation Plan §14.1 (signup + KYC), §4.5 (webhook signing).
 *
 * In v1 the implementation is intentionally provider-agnostic — the public
 * function takes a normalized result, and the controller adapts the provider
 * payload to it. When we wire a real provider, only the controller changes.
 */

import { Injectable, Logger, UnauthorizedException } from "@nestjs/common";
import { KycStatus } from "@prisma/client";
import { createHmac, timingSafeEqual } from "node:crypto";

import { PrismaService } from "../../../common/prisma.service";
import { AuditService } from "../../audit/audit.service";
import { VendorService } from "../../vendors/vendor.service";

export type NormalizedKycOutcome = "verified" | "requires_input" | "rejected" | "expired";

@Injectable()
export class KycService {
  private readonly logger = new Logger(KycService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly vendors: VendorService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Verify an HMAC-SHA256 signature shared with the KYC provider.
   * Header format: `t=<timestamp>,v1=<signature>` (Stripe convention).
   * Throws UnauthorizedException on any mismatch.
   */
  verifySignature(rawBody: Buffer, signatureHeader: string | undefined, secret: string, toleranceSeconds = 300): void {
    if (!signatureHeader) {
      throw new UnauthorizedException("Missing signature header.");
    }
    const parts = Object.fromEntries(
      signatureHeader.split(",").map((s) => {
        const [k, v] = s.split("=");
        return [k?.trim() ?? "", v?.trim() ?? ""];
      }),
    );
    const ts = parts.t;
    const sig = parts.v1;
    if (!ts || !sig) throw new UnauthorizedException("Malformed signature header.");

    const tsNum = Number.parseInt(ts, 10);
    if (!Number.isFinite(tsNum) || Math.abs(Date.now() / 1000 - tsNum) > toleranceSeconds) {
      throw new UnauthorizedException("Signature timestamp out of tolerance.");
    }

    const signedPayload = `${ts}.${rawBody.toString("utf8")}`;
    const expected = createHmac("sha256", secret).update(signedPayload).digest("hex");

    const a = Buffer.from(expected);
    const b = Buffer.from(sig);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new UnauthorizedException("Signature mismatch.");
    }
  }

  /**
   * Process a normalized outcome. Idempotent on event_id via the
   * idempotency_keys table — replaying the same webhook is a no-op.
   */
  async applyOutcome(args: {
    eventId: string;
    vendorId: string;
    providerSessionId: string;
    outcome: NormalizedKycOutcome;
  }): Promise<void> {
    // De-dupe via idempotency_keys (key format: "kyc:<event_id>").
    const idempotencyKey = `kyc:${args.eventId}`;
    const existing = await this.prisma.idempotencyKey.findUnique({ where: { key: idempotencyKey } });
    if (existing) {
      this.logger.log({ eventId: args.eventId }, "KYC webhook already processed; ignoring.");
      return;
    }

    const next: KycStatus =
      args.outcome === "verified"
        ? KycStatus.APPROVED
        : args.outcome === "requires_input"
          ? KycStatus.REQUIRES_RESUBMISSION
          : args.outcome === "expired"
            ? KycStatus.EXPIRED
            : KycStatus.REJECTED;

    await this.prisma.$transaction(async (tx) => {
      await this.vendors.setKycStatus(args.vendorId, next, args.providerSessionId);
      await tx.idempotencyKey.create({
        data: {
          key: idempotencyKey,
          endpoint: "kyc.webhook",
          requestHash: args.eventId,
          responseStatus: 200,
          responseBody: { ok: true } as object,
          vendorId: args.vendorId,
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30d
        },
      });
    });

    await this.audit.log({
      action: "kyc.webhook_processed",
      resourceType: "vendor",
      resourceId: args.vendorId,
      afterState: { outcome: args.outcome, kycStatus: next, providerSessionId: args.providerSessionId },
    });
  }
}
