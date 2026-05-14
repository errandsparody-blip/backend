/**
 * Stripe webhook handler.
 *
 *   - PUBLIC (no JWT) — protected by HMAC signature.
 *   - Idempotent — every event id is recorded in webhook_events; replays no-op.
 *   - Atomic — wallet credit + webhook_events insert in a single transaction.
 *
 * Implementation Plan §6.5.1, §11.2 (Webhooks), §14.2.
 *
 * Events handled:
 *   payment_intent.succeeded → credit wallet for `metadata.netAmountCents`
 *   payment_intent.payment_failed → log + alert
 *   charge.refunded → credit reversal (negative DEPOSIT? no — REVERSAL)
 *   charge.dispute.created → flag + audit (resolution P2.13)
 *
 * Wallet credit happens HERE, not at deposit-create time. This is the
 * single-source-of-truth pattern — Stripe is authoritative on whether money
 * actually moved.
 */

import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { Prisma } from "@prisma/client";
import type { Request } from "express";
import type Stripe from "stripe";

import { Public } from "../../../common/decorators/public.decorator";
import { PrismaService } from "../../../common/prisma.service";
import { AuditService } from "../../audit/audit.service";
import { depositReceiptTemplate } from "../../email/email-templates";
import { NotificationService } from "../../notifications/notification.service";
import { ShopperRequestService } from "../../shopper/shopper-request.service";
import { WalletService } from "../../wallet/wallet.service";

import { StripeService } from "./stripe.service";

@Controller({ path: "webhooks/stripe", version: "1" })
export class StripeWebhookController {
  private readonly logger = new Logger(StripeWebhookController.name);

  constructor(
    private readonly stripe: StripeService,
    private readonly wallet: WalletService,
    private readonly audit: AuditService,
    private readonly prisma: PrismaService,
    private readonly shopper: ShopperRequestService,
    private readonly notifications: NotificationService,
  ) {}

  @Public()
  @Post()
  @HttpCode(HttpStatus.OK)
  // Defence: a forged or replayed flood must not be able to keep CPU busy on
  // signature verification. Stripe's normal cadence is well below this.
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  async handle(
    @Headers("stripe-signature") signature: string | undefined,
    @Req() req: Request & { rawBody?: Buffer },
    @Body() _body: unknown,
  ): Promise<{ ok: true; deduped?: true }> {
    const raw = req.rawBody ?? Buffer.from(JSON.stringify(_body ?? {}));

    // 1. Verify signature. Throws on tamper.
    let event: Stripe.Event;
    try {
      event = this.stripe.verifyWebhook(raw, signature);
    } catch (err) {
      this.logger.warn({ err }, "Stripe webhook signature verification failed");
      // Returning 200 here would let an attacker know we received the call but
      // verification failed; respond 400 so Stripe retries (legitimate replays
      // hit this on transient signature mismatch).
      throw err;
    }

    // 2. Dedupe via webhook_events. The unique index on (provider, event_id)
    //    is the integrity gate. We attempt insert first — duplicates fail with
    //    P2002 and we treat as already-processed.
    try {
      await this.prisma.webhookEvent.create({
        data: {
          provider: "stripe",
          eventId: event.id,
          payload: event as unknown as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "P2002") {
        this.logger.log({ eventId: event.id }, "Stripe webhook duplicate; ignoring.");
        return { ok: true, deduped: true };
      }
      throw err;
    }

    // 3. Dispatch by type.
    try {
      switch (event.type) {
        case "payment_intent.succeeded":
          await this.handlePaymentSucceeded(event.data.object as Stripe.PaymentIntent);
          break;
        case "payment_intent.payment_failed":
          await this.handlePaymentFailed(event.data.object as Stripe.PaymentIntent);
          break;
        case "charge.refunded":
          await this.handleChargeRefunded(event.data.object as Stripe.Charge);
          break;
        case "charge.dispute.created":
          await this.handleDisputeCreated(event.data.object as Stripe.Dispute);
          break;
        // Personal Shopper — Checkout-based payments. We listen to the
        // session-level event because that's what fires at the moment
        // payment is confirmed in Checkout (a couple seconds before the
        // payment_intent.succeeded sibling event). Both arrive though;
        // ShopperRequestService.markIntakePaid is idempotent on intentId
        // so a double-handle is a no-op.
        case "checkout.session.completed":
          await this.handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
          break;
        default:
          this.logger.log({ type: event.type, eventId: event.id }, "Stripe event ignored.");
      }

      await this.prisma.webhookEvent.update({
        where: { id: (await this.prisma.webhookEvent.findFirst({
          where: { provider: "stripe", eventId: event.id },
          select: { id: true },
        }))!.id },
        data: { processedAt: new Date() },
      });
    } catch (err) {
      // Security audit M-2 — on dispatch failure, DELETE the
      // webhook_events row so the next Stripe retry can reprocess
      // instead of being silently marked `deduped`. We still emit a
      // structured log so finance can investigate transient failures
      // (the deletion erases the audit-log forensic trail otherwise).
      this.logger.error(
        {
          err,
          eventId: event.id,
          eventType: event.type,
          errMessage: (err as Error).message,
        },
        "stripe.webhook.dispatch_failed_row_deleted_for_retry",
      );
      try {
        await this.prisma.webhookEvent.deleteMany({
          where: { provider: "stripe", eventId: event.id },
        });
      } catch (delErr) {
        // If the cleanup fails, fall back to the old behaviour — leave
        // the row in place with the error captured. Stripe will give
        // up after its retry budget; finance can then manually
        // reconcile via the audit log.
        this.logger.error(
          { err: delErr, eventId: event.id },
          "stripe.webhook.failure_row_cleanup_failed",
        );
        await this.prisma.webhookEvent
          .updateMany({
            where: { provider: "stripe", eventId: event.id },
            data: { error: (err as Error).message },
          })
          .catch(() => undefined);
      }
      throw err;
    }

    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // Event handlers
  // ---------------------------------------------------------------------------

  private async handlePaymentSucceeded(intent: Stripe.PaymentIntent): Promise<void> {
    const purpose = intent.metadata?.["purpose"];

    // Shopper intents — handled in checkout.session.completed too, but the
    // PaymentIntent event is our second-chance / safety-net. Both branches
    // call the idempotent ShopperRequestService methods.
    if (purpose === "shopper.intake") {
      const requestId = intent.metadata?.["shopperRequestId"];
      if (!requestId) {
        this.logger.error({ id: intent.id }, "Shopper intake intent missing requestId.");
        return;
      }
      await this.shopper.markIntakePaid({ requestId, stripeIntentId: intent.id });
      return;
    }
    if (purpose === "shopper.followup") {
      const requestId = intent.metadata?.["shopperRequestId"];
      if (!requestId) {
        this.logger.error({ id: intent.id }, "Shopper follow-up intent missing requestId.");
        return;
      }
      await this.shopper.markFollowupPaid({ requestId, stripeIntentId: intent.id });
      return;
    }
    // Migration 0027 — shipping invoice paid via Stripe Checkout. Same
    // safety-net pattern as intake/followup: both the PI event and the
    // sibling checkout.session.completed event call the idempotent
    // markShippingPaid so a double-fire is a no-op.
    if (purpose === "shopper.shipping") {
      const requestId = intent.metadata?.["shopperRequestId"];
      if (!requestId) {
        this.logger.error({ id: intent.id }, "Shopper shipping intent missing requestId.");
        return;
      }
      await this.shopper.markShippingPaid({ requestId, stripeIntentId: intent.id });
      return;
    }

    if (purpose !== "wallet.fund") {
      // Future intents (e.g., onboarding fee deposits if we ever do them) go here.
      this.logger.log({ id: intent.id, purpose }, "Ignoring intent without wallet.fund purpose.");
      return;
    }
    const vendorId = intent.metadata?.["vendorId"];
    const netAmountCents = Number(intent.metadata?.["netAmountCents"] ?? "0");

    if (!vendorId || !Number.isFinite(netAmountCents) || netAmountCents <= 0) {
      this.logger.error({ id: intent.id }, "Wallet-fund intent missing required metadata.");
      throw new Error("Stripe wallet-fund intent has invalid metadata.");
    }

    const result = await this.wallet.credit({
      vendorId,
      amountCents: netAmountCents,
      type: "DEPOSIT",
      description: `Stripe deposit · ${intent.id}`,
      referenceType: "stripe_payment_intent",
      referenceId: intent.id,
      idempotencyKey: intent.id,
    });

    // Receipt — wallet was credited, vendor should know. Best-effort:
    // failures here don't roll back the credit (which Stripe already
    // settled). The notification fanout finds every active user on the
    // vendor and emails each one.
    const tpl = depositReceiptTemplate({
      amountCents: netAmountCents,
      balanceAfterCents: result.balanceAfterCents,
      reference: intent.id,
    });
    await this.notifications.emit({
      vendorId,
      type: "wallet.deposit_received",
      severity: "INFO",
      title: `Wallet credited $${(netAmountCents / 100).toFixed(2)}`,
      body: `Stripe deposit · ${intent.id}. New balance: $${(result.balanceAfterCents / 100).toFixed(2)}.`,
      href: "/wallet",
      email: { subject: tpl.subject, html: tpl.html, text: tpl.text },
    });
  }

  /**
   * Handle a completed Checkout Session. Only shopper sessions live here —
   * wallet funding uses PaymentIntent flows directly (no Checkout). Routes
   * to either intake-paid or follow-up-paid based on the session metadata.
   */
  private async handleCheckoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
    const purpose = session.metadata?.["purpose"];
    const requestId = session.metadata?.["shopperRequestId"];
    if (!purpose || !purpose.startsWith("shopper.")) {
      this.logger.log({ id: session.id, purpose }, "Non-shopper checkout session ignored.");
      return;
    }
    if (!requestId) {
      this.logger.error({ id: session.id }, "Shopper checkout session missing requestId.");
      return;
    }
    if (session.payment_status !== "paid") {
      // Async / Buy-Now-Pay-Later flows can fire this with a non-paid status.
      // We defer to the corresponding payment_intent.succeeded event in that
      // case. Refusing to mark paid keeps the status guard tight.
      this.logger.log(
        { id: session.id, payment_status: session.payment_status },
        "Checkout session completed but not paid; deferring to PI event.",
      );
      return;
    }
    const intentId =
      typeof session.payment_intent === "string"
        ? session.payment_intent
        : session.payment_intent?.id;
    if (!intentId) {
      this.logger.error({ id: session.id }, "Shopper checkout session missing payment intent.");
      return;
    }

    if (purpose === "shopper.intake") {
      await this.shopper.markIntakePaid({ requestId, stripeIntentId: intentId });
    } else if (purpose === "shopper.followup") {
      await this.shopper.markFollowupPaid({ requestId, stripeIntentId: intentId });
    } else if (purpose === "shopper.shipping") {
      // Migration 0027 — shipping invoice paid via Stripe Checkout.
      await this.shopper.markShippingPaid({ requestId, stripeIntentId: intentId });
    } else {
      this.logger.warn({ id: session.id, purpose }, "Unknown shopper checkout purpose.");
    }
  }

  private async handlePaymentFailed(intent: Stripe.PaymentIntent): Promise<void> {
    const vendorId = intent.metadata?.["vendorId"] ?? null;
    await this.audit.log({
      action: "stripe.payment_failed",
      resourceType: "stripe_payment_intent",
      resourceId: intent.id,
      onBehalfOfVendorId: vendorId,
      afterState: {
        last_payment_error: intent.last_payment_error?.code ?? null,
        amount: intent.amount,
      },
    });
  }

  private async handleChargeRefunded(charge: Stripe.Charge): Promise<void> {
    // Branch by the metadata stamped onto the underlying PaymentIntent.
    // Wallet funding charges carry vendorId + netAmountCents (we credit a
    // REVERSAL); shopper charges carry shopperRequestId (we audit + maybe
    // mark the request REFUNDED).
    //
    // Stripe-Dashboard-issued refunds AND admin-initiated ones both hit
    // here. Our admin path already updates the DB synchronously, so the
    // webhook is mostly a safety net that catches:
    //   - support refunding directly from Stripe Dashboard
    //   - dispute-driven automatic refunds
    // For both, we want the audit row + a status update if the charge is
    // now fully refunded.
    const purpose = charge.metadata?.["purpose"] ?? "";
    if (purpose.startsWith("shopper.")) {
      await this.handleShopperChargeRefunded(charge);
      return;
    }

    const vendorId = charge.metadata?.["vendorId"];
    const netAmountCents = Number(charge.metadata?.["netAmountCents"] ?? "0");
    if (!vendorId || !Number.isFinite(netAmountCents) || netAmountCents <= 0) {
      this.logger.warn({ id: charge.id }, "Refund webhook missing metadata; skipping wallet adjustment.");
      return;
    }
    // Symmetric reversal — we credit a NEGATIVE wallet adjustment via the
    // REVERSAL ledger type (which permits either sign). Implementation Plan §11.3.
    await this.wallet.credit({
      vendorId,
      // Reversal of a deposit is negative.
      amountCents: netAmountCents,
      type: "REVERSAL",
      description: `Stripe refund · ${charge.id}`,
      referenceType: "stripe_charge",
      referenceId: charge.id,
    });
  }

  /**
   * Refund webhook for a shopper-purpose charge (intake or follow-up).
   *
   * - Always writes an audit entry so support can reconcile.
   * - If the charge is now FULLY refunded (`amount_refunded === amount_captured`)
   *   AND the request isn't already in a terminal-refunded state, we mark
   *   the request REFUNDED. We don't store the Stripe refund id here —
   *   Dashboard-initiated refunds aren't tied to one of our cancel-refund
   *   slots, and overwriting `cancelIntakeRefundId` blindly could clobber
   *   the admin-flow's own refund id. The Stripe charge id + audit row is
   *   sufficient forensic linkage.
   */
  private async handleShopperChargeRefunded(charge: Stripe.Charge): Promise<void> {
    const requestId = charge.metadata?.["shopperRequestId"] ?? null;
    const purpose = charge.metadata?.["purpose"] ?? "shopper.unknown";
    if (!requestId) {
      this.logger.warn({ id: charge.id }, "Shopper refund webhook missing requestId.");
      return;
    }

    await this.audit.log({
      action: "shopper.charge.refunded",
      resourceType: "shopper_request",
      resourceId: requestId,
      afterState: {
        purpose,
        chargeId: charge.id,
        amountCaptured: charge.amount_captured,
        amountRefunded: charge.amount_refunded,
        fullyRefunded: charge.amount_refunded >= charge.amount_captured,
      },
    });

    if (charge.amount_refunded >= charge.amount_captured) {
      // Best-effort terminal status flip. Returning a non-error status from
      // shopper.cancel when the row is already REFUNDED/CANCELLED is fine —
      // we ignore that ConflictException to keep the webhook idempotent.
      try {
        await this.shopper.cancel({
          requestId,
          reason: `Stripe refund webhook · ${charge.id}`,
          // Webhooks have no human actor — null is acceptable on the
          // audit row. The "reason" string above identifies the webhook
          // path for forensics.
          actorId: null,
          refundedAmountCents: charge.amount_refunded,
        });
      } catch (err) {
        // Already in a terminal state, or another race resolved first.
        // Audit row is already in place; we don't need to retry.
        this.logger.log(
          { err, requestId, chargeId: charge.id },
          "shopper.charge.refunded: terminal state already reached, no-op",
        );
      }
    }
  }

  private async handleDisputeCreated(dispute: Stripe.Dispute): Promise<void> {
    await this.audit.log({
      action: "stripe.dispute_created",
      resourceType: "stripe_charge",
      resourceId: typeof dispute.charge === "string" ? dispute.charge : dispute.charge.id,
      afterState: {
        amount: dispute.amount,
        reason: dispute.reason,
        status: dispute.status,
      },
    });
    // Real chargeback handling lands in P2.13 (suspension on repeat).
  }
}
