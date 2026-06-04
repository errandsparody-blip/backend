/**
 * Admin Shopper controller — operator + finance endpoints.
 *
 *   GET    /v1/admin/shopper                              — queue / list
 *   GET    /v1/admin/shopper/:id                          — full detail (incl. messages)
 *   POST   /v1/admin/shopper/:id/start                    — PAID → PROCURING
 *   PATCH  /v1/admin/shopper/:id/lines/:lineId            — set procurement status + notes
 *   POST   /v1/admin/shopper/:id/shipping                 — set method + parcel + dest
 *   POST   /v1/admin/shopper/:id/delivered-to-warehouse   — AWAITING_DELIVERY → READY_TO_SHIP
 *   POST   /v1/admin/shopper/:id/finalize                 — legacy reconciliation flow (kept
 *                                                          for in-flight pre-redesign rows)
 *   POST   /v1/admin/shopper/:id/followup/send            — legacy: issue Checkout/Refund
 *   POST   /v1/admin/shopper/:id/ship                     — attach carrier + tracking
 *   POST   /v1/admin/shopper/:id/cancel                   — cancel ± refund
 *   POST   /v1/admin/shopper/:id/messages                 — admin posts to thread
 *   POST   /v1/admin/shopper/:id/read                     — admin marks buyer messages read
 *
 * Roles:
 *   - WAREHOUSE_OPERATOR / FINANCE_ADMIN / SUPER_ADMIN — most actions.
 *   - Cancel + refund + finalize gated to FINANCE_ADMIN / SUPER_ADMIN to
 *     keep money operations off the warehouse role.
 */

import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  InternalServerErrorException,
  Logger,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Role } from "@prisma/client";

import { loadConfig } from "../../common/config";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../../common/guards/jwt-auth.guard";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { PrismaService } from "../../common/prisma.service";
import {
  adminApproveShopperIdSchema,
  adminCancelShopperSchema,
  adminConfirmShopperWireSchema,
  adminListShopperRequestsSchema,
  adminMarkPickedUpSchema,
  adminRejectShopperIdSchema,
  adminRejectShopperWireSchema,
  adminReleaseWithBuyerLabelSchema,
  adminSendFollowupSchema,
  adminSendShopperQuoteSchema,
  adminSetShopperShippingSchema,
  adminShipShopperSchema,
  adminUpdateShopperLineSchema,
  postShopperMessageSchema,
  presignShopperUploadSchema,
  type AdminApproveShopperIdInput,
  type AdminCancelShopperInput,
  type AdminConfirmShopperWireInput,
  type AdminListShopperRequestsInput,
  type AdminMarkPickedUpInput,
  type AdminRejectShopperIdInput,
  type AdminRejectShopperWireInput,
  type AdminReleaseWithBuyerLabelInput,
  type AdminSendFollowupInput,
  type AdminSendShopperQuoteInput,
  type AdminSetShopperShippingInput,
  type AdminShipShopperInput,
  type AdminUpdateShopperLineInput,
  type PostShopperMessageInput,
  type PresignShopperUploadInput,
} from "../../common/schemas/shopper.schema";
import { EmailService } from "../email/email.service";
import {
  shopperFollowupOwedTemplate,
  shopperNewMessageTemplate,
  shopperRefundIssuedTemplate,
  shopperShippedTemplate,
  shopperShippingInvoiceTemplate,
} from "../email/email-templates";
import { R2Service } from "../integrations/r2/r2.service";
import { StripeService } from "../integrations/stripe/stripe.service";

import {
  buyerIdCheckPassed,
  loadWireThresholdCents,
} from "./shopper-id-verification.util";
import { ShopperMessageService } from "./shopper-message.service";
import { ShopperReceiptService } from "./shopper-receipt.service";
import { ShopperRequestService } from "./shopper-request.service";
import { ShopperTokenService } from "./shopper-token.service";

const FINANCE_ROLES = [Role.FINANCE_ADMIN, Role.SUPER_ADMIN] as const;

@Controller({ path: "admin/shopper", version: "1" })
@Roles(Role.WAREHOUSE_OPERATOR, Role.FINANCE_ADMIN, Role.SUPER_ADMIN)
export class AdminShopperController {
  private readonly logger = new Logger(AdminShopperController.name);

  constructor(
    private readonly requests: ShopperRequestService,
    private readonly messages: ShopperMessageService,
    private readonly tokens: ShopperTokenService,
    private readonly stripe: StripeService,
    private readonly email: EmailService,
    private readonly prisma: PrismaService,
    private readonly r2: R2Service,
    private readonly receipts: ShopperReceiptService,
  ) {}

  // ---------------------------------------------------------------------------
  // List + detail
  // ---------------------------------------------------------------------------

  @Get()
  list(
    @Query(new ZodValidationPipe(adminListShopperRequestsSchema))
    q: AdminListShopperRequestsInput,
  ) {
    return this.requests.list(q);
  }

  @Get(":id")
  async get(@Param("id", new ParseUUIDPipe()) id: string) {
    const [request, messages] = await Promise.all([
      this.requests.getById(id),
      this.messages.listForRequest(id),
    ]);

    // Resolve the parent's human-readable reference (UUID → SHP-XXXXX)
    // so the admin UI can render "Addition to SHP-000041" alongside this
    // request without making a second client-side lookup. Best-effort —
    // a missing parent (cascade-deleted or revoked) collapses to null.
    let parentReference: string | null = null;
    if (request.parentRequestId) {
      const parent = await this.requests
        .getById(request.parentRequestId, { includeLines: false })
        .catch(() => null);
      parentReference = parent?.reference ?? null;
    }

    return { request: { ...request, parentReference }, messages };
  }

  // ---------------------------------------------------------------------------
  // Procurement transitions
  // ---------------------------------------------------------------------------

  @Post(":id/start")
  @HttpCode(HttpStatus.OK)
  start(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", new ParseUUIDPipe()) id: string,
  ) {
    return this.requests.startProcurement({ requestId: id, actorId: user.sub });
  }

  /**
   * Migration 0021 — admin confirms the items have landed at the warehouse
   * and the request can move to READY_TO_SHIP. No body required; the action
   * is idempotent at the transition level (a second call would 409).
   */
  @Post(":id/delivered-to-warehouse")
  @HttpCode(HttpStatus.OK)
  deliveredToWarehouse(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", new ParseUUIDPipe()) id: string,
  ) {
    return this.requests.markDeliveredToWarehouse({
      requestId: id,
      actorId: user.sub,
    });
  }

  @Patch(":id/lines/:lineId")
  updateLine(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Param("lineId", new ParseUUIDPipe()) lineId: string,
    @Body(new ZodValidationPipe(adminUpdateShopperLineSchema))
    body: AdminUpdateShopperLineInput,
  ) {
    return this.requests.updateLine({
      requestId: id,
      lineId,
      input: body,
      actorId: user.sub,
    });
  }

  @Post(":id/shipping")
  @HttpCode(HttpStatus.OK)
  async setShipping(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(adminSetShopperShippingSchema))
    body: AdminSetShopperShippingInput,
  ) {
    // Phase 2 redesign — admin types the per-lb rate inline for this
    // request. We still load the legacy config map so requests that
    // don't supply a rate (older clients, scripted updates) keep their
    // existing behaviour, but the per-request value always wins.
    const freightRates = await this.loadFreightRates();
    const effectiveRates = { ...freightRates };
    if (
      body.shippingMethod &&
      typeof body.shippingRateCentsPerLb === "number"
    ) {
      effectiveRates[body.shippingMethod] = body.shippingRateCentsPerLb;
    }
    const updated = await this.requests.setShipping({
      requestId: id,
      input: body,
      actorId: user.sub,
      freightRates: effectiveRates,
    });

    // Post the freshly-updated breakdown into the chat thread so the buyer
    // can preview the numbers BEFORE we send the follow-up invoice. This is
    // best-effort — a receipt failure must not undo the shipping save.
    let receipt: { imageUrl: string | null; html: string; text: string } = {
      imageUrl: null,
      html: "",
      text: "",
    };
    try {
      const note =
        "Updated breakdown — shipping cost, sales tax, and parcel details have been finalised. " +
        "The shipping invoice below covers freight only; pay it to release your package.";
      receipt = await this.buildAndPostReceipt(id, user.sub, note);
    } catch (err) {
      this.logger.warn(
        { err, requestId: id },
        "shopper.shipping.receipt_post_failed",
      );
    }

    // Migration 0027 — shipping-invoice payment cycle.
    //
    // After saving the shipping form, if the row has a non-zero
    // shipping cost AND the buyer hasn't already paid for shipping on
    // this request, issue a Stripe Checkout session for the freight
    // line. The session url is posted into the chat thread + emailed
    // to the buyer so they can pay before admin advances the request
    // toward shipment. The gate is enforced server-side in
    // ShopperRequestService.assertShippingPaid (so a malicious admin
    // can't fast-forward without payment).
    //
    // Zero-cost methods (BUYER_FREIGHT, PICKUP) skip this branch
    // entirely — there's nothing to invoice. Re-saving with a different
    // amount creates a fresh Checkout session (different idempotency
    // key); re-saving with the SAME amount returns the existing session
    // so the buyer's pay link doesn't churn.
    const updatedAny = updated as unknown as {
      shippingCostCents: number | null;
      shippingPaidAt: Date | null;
      shippingMethod: string | null;
    };
    const chargedCents = updatedAny.shippingCostCents ?? 0;
    const shippingMethod = updatedAny.shippingMethod ?? "";
    const NEEDS_INVOICE = ["PLATFORM_FREIGHT", "BUYER_FORWARDER"] as const;
    const shouldInvoice =
      chargedCents > 0 &&
      !updatedAny.shippingPaidAt &&
      (NEEDS_INVOICE as ReadonlyArray<string>).includes(shippingMethod);

    if (shouldInvoice) {
      const cfg = loadConfig();
      // Fresh thread token for the email + success URLs. Same pattern
      // as sendFollowup — we don't store plaintext, each issuance is
      // independently valid until expiry/revocation.
      let fresh: string;
      try {
        const issued = await this.tokens.issue(id);
        fresh = issued.plaintext;
      } catch (err) {
        this.logger.error(
          { err, requestId: id },
          "shopper.shipping.token_issue_failed",
        );
        // Don't unwind the shipping save — admin can retry the
        // invoice issuance by re-saving. Surface a partial-success
        // signal so the UI knows to re-save if the buyer reports
        // never receiving the pay link.
        return {
          ...updated,
          shippingInvoiceWarning: "token_issue_failed" as const,
        };
      }

      let session: { sessionId: string; paymentIntentId: string | null; url: string };
      try {
        session = await this.stripe.createShopperShippingSession({
          requestId: id,
          buyerEmail: updated.buyerEmail,
          amountCents: chargedCents,
          description: `Shipping & handling · ${updated.reference}`,
          // Per-request + per-amount idempotency: changing the cost
          // produces a new session; re-saving the same cost returns
          // the existing one (no orphaned Checkout pages).
          idempotencyKey: `shopper:shipping:${id}:${chargedCents}`,
          successUrl: `${cfg.WEB_PUBLIC_URL}/shopper/r/${encodeURIComponent(fresh)}?shipping=paid`,
          cancelUrl: `${cfg.WEB_PUBLIC_URL}/shopper/r/${encodeURIComponent(fresh)}?shipping=cancelled`,
        });
      } catch (err) {
        this.logger.error(
          {
            err,
            requestId: id,
            errMessage: (err as Error)?.message,
            errName: (err as Error)?.name,
          },
          "shopper.shipping.stripe_session_failed",
        );
        // Admin can re-save to retry the Stripe call. Don't unwind
        // the shipping form save — the freight number is still
        // useful for the receipt + admin overview.
        throw new ServiceUnavailableException({
          message:
            "Shipping was saved but the buyer's pay link couldn't be created. Re-save the shipping form to retry the Stripe call.",
          code: "shopper_shipping_stripe_failed",
          stripeError: (err as Error)?.message ?? null,
        });
      }

      // Security audit M-3 — if the row already pointed at a different
      // Checkout session, expire it on Stripe's side so any stale
      // pay-link the buyer might still have (email, chat history)
      // becomes inert. Best-effort: a failure here is non-fatal
      // because the new session is the only one we'll surface in the
      // UI going forward, and stale links naturally expire in 24h
      // even without our help.
      const previousSessionId = (updated as unknown as {
        shippingInvoiceSessionId?: string | null;
      }).shippingInvoiceSessionId;
      if (previousSessionId && previousSessionId !== session.sessionId) {
        await this.stripe
          .expireCheckoutSession(previousSessionId)
          .catch(() => undefined);
      }

      try {
        await this.requests.attachShippingSession({
          requestId: id,
          sessionId: session.sessionId,
          intentId: session.paymentIntentId,
          url: session.url,
        });
      } catch (err) {
        this.logger.error(
          { err, requestId: id, sessionId: session.sessionId },
          "shopper.shipping.session_attach_failed",
        );
        throw new InternalServerErrorException({
          message:
            "Stripe session created but couldn't be saved on the request. Re-save the shipping form — Stripe will return the same session.",
          code: "shopper_shipping_attach_failed",
          stripeSessionId: session.sessionId,
        });
      }

      const dollars = (cents: number): string =>
        `$${(cents / 100).toFixed(2)}`;

      // Post the pay link into the chat thread as a separate, focused
      // message so it stands apart from the receipt note above. Best-
      // effort — a chat-post failure must not undo the Stripe call.
      const invoiceLine =
        `Shipping invoice: ${dollars(chargedCents)}.\n\n` +
        `Pay securely (Stripe): ${session.url}\n\n` +
        `As soon as this is paid we'll release your package for shipment and email you tracking. ` +
        `The receipt above shows how this number was calculated.`;
      try {
        await this.postAdminNote(id, invoiceLine, user.sub);
      } catch (err) {
        this.logger.warn(
          { err, requestId: id },
          "shopper.shipping.invoice_chat_failed",
        );
      }

      // Email the buyer with the pay link + inline receipt. Best-
      // effort — Resend failures are non-fatal for the action.
      try {
        const tpl = shopperShippingInvoiceTemplate({
          reference: updated.reference,
          threadToken: fresh,
          shippingPayUrl: session.url,
          amountCents: chargedCents,
          shippingMethod,
          receiptHtml: receipt.html || undefined,
          receiptText: receipt.text || undefined,
          receiptImageUrl: receipt.imageUrl,
        });
        void this.email.send({
          to: updated.buyerEmail,
          subject: tpl.subject,
          html: tpl.html,
          text: tpl.text,
          // Per-request + per-amount key so a re-save with a NEW amount
          // sends a fresh email, but two clicks with the same number
          // don't spam the buyer.
          idempotencyKey: `shopper:shipping_email:${id}:${chargedCents}`,
          type: "shopper.shipping_invoice",
        });
      } catch (err) {
        this.logger.warn(
          { err, requestId: id },
          "shopper.shipping.invoice_email_failed",
        );
      }

      // Return the freshly attached session info so the admin UI can
      // surface the pay link immediately without a follow-up fetch.
      return {
        ...updated,
        shippingInvoiceSessionId: session.sessionId,
        shippingInvoiceIntentId: session.paymentIntentId,
        shippingInvoiceUrl: session.url,
      };
    }

    return updated;
  }

  // ---------------------------------------------------------------------------
  // Finalize reconciliation — money-affecting, finance-only
  // ---------------------------------------------------------------------------

  @Post(":id/finalize")
  @HttpCode(HttpStatus.OK)
  finalize(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", new ParseUUIDPipe()) id: string,
  ) {
    this.assertFinanceRole(user);
    return this.requests.finalizeReconciliation({ requestId: id, actorId: user.sub });
  }

  /**
   * Sends the follow-up. Three branches based on the snapshotted
   * `followupAmountCents` from `finalize`:
   *
   *   amount > 0 → create Stripe Checkout session, email buyer.
   *   amount < 0 → issue Stripe refund against intake intent, email buyer.
   *   amount = 0 → mark as resolved, no money moves.
   */
  @Post(":id/followup/send")
  @HttpCode(HttpStatus.OK)
  async sendFollowup(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(adminSendFollowupSchema)) body: AdminSendFollowupInput,
  ) {
    this.assertFinanceRole(user);

    const cfg = loadConfig();
    const request = await this.requests.getById(id, { includeLines: false });

    if (request.status !== "AWAITING_RECONCILIATION") {
      throw new BadRequestException({
        message: "Finalize the reconciliation before sending the follow-up.",
        code: "shopper_followup_not_finalized",
      });
    }
    if (request.followupAmountCents == null) {
      throw new InternalServerErrorException({
        message: "Follow-up amount missing — finalization did not complete.",
        code: "shopper_followup_amount_missing",
      });
    }
    if (request.followupResolvedAt) {
      throw new BadRequestException({
        message: "Follow-up has already been resolved.",
        code: "shopper_followup_already_resolved",
      });
    }

    // The admin's optional note is held aside here — we don't post it as
    // its own chat message anymore. Each branch below posts ONE combined
    // chat message: the admin's note (if any) + the auto-generated text
    // describing what just happened (with the Stripe link / refund
    // confirmation). The thread thus becomes the canonical place to find
    // the invoice — buyers don't have to dig through email.
    const adminNote = body.message?.trim() ?? "";

    function dollars(cents: number): string {
      return `$${(cents / 100).toFixed(2)}`;
    }

    // Mint a fresh thread token for the email link. We can't recover plaintext
    // from a hash, so each follow-up email gets a brand-new token issued
    // here. Buyers can use either the original or this one — both are valid
    // until expiry/revocation. Wrapped in try/catch so a DB hiccup at this
    // step surfaces a clear `code` instead of the generic 500 we'd otherwise
    // return (and which made this exact path painful to debug in production).
    let fresh: string;
    try {
      const issued = await this.tokens.issue(id);
      fresh = issued.plaintext;
    } catch (err) {
      this.logger.error({ err, requestId: id }, "shopper.followup.token_issue_failed");
      throw new InternalServerErrorException({
        message: "Couldn't prepare the buyer's thread link. Try again, or contact engineering.",
        code: "shopper_followup_token_failed",
      });
    }

    if (request.followupAmountCents > 0) {
      // Positive delta — issue a Checkout session.
      let session: { sessionId: string; paymentIntentId: string | null; url: string };
      try {
        session = await this.stripe.createShopperFollowupSession({
          requestId: id,
          buyerEmail: request.buyerEmail,
          amountCents: request.followupAmountCents,
          description: "Adjustment + shipping",
          idempotencyKey: `shopper:followup:${id}`,
          successUrl: `${cfg.WEB_PUBLIC_URL}/shopper/r/${encodeURIComponent(fresh)}?followup=paid`,
          cancelUrl: `${cfg.WEB_PUBLIC_URL}/shopper/r/${encodeURIComponent(fresh)}?followup=cancelled`,
        });
      } catch (err) {
        // Most common cause: STRIPE_SECRET_KEY missing on this environment.
        // The Stripe SDK throws raw Errors, not structured exceptions, so
        // without this catch the global filter wraps them as opaque 500s.
        this.logger.error(
          {
            err,
            requestId: id,
            errMessage: (err as Error)?.message,
            errName: (err as Error)?.name,
          },
          "shopper.followup.stripe_session_failed",
        );
        throw new ServiceUnavailableException({
          message:
            "Couldn't issue a Checkout session. Stripe may not be configured for this environment, or the Stripe API rejected the request — check the server logs for the correlation id, then verify STRIPE_SECRET_KEY in Railway and the Stripe dashboard's recent activity.",
          code: "shopper_followup_stripe_failed",
          stripeError: (err as Error)?.message ?? null,
        });
      }

      try {
        await this.requests.attachFollowupSession(id, session.sessionId, session.paymentIntentId);
      } catch (err) {
        // Stripe accepted but DB write failed. The session exists; admin can
        // retry — idempotency key returns the same session — but we surface
        // the failure so the row's followupStripeSessionId column gets
        // populated on retry.
        this.logger.error(
          { err, requestId: id, sessionId: session.sessionId },
          "shopper.followup.session_attach_failed",
        );
        throw new InternalServerErrorException({
          message:
            "Stripe session created but couldn't be saved on the request. Click Send checkout again — Stripe will return the same session.",
          code: "shopper_followup_attach_failed",
          stripeSessionId: session.sessionId,
        });
      }

      // Post the invoice + visual receipt into the chat thread so the buyer
      // sees both the explanation and the breakdown the moment they open
      // the page — not only in email. The combined body includes any
      // optional admin note up top, then the system-generated invoice
      // text + Stripe link, with the receipt image as an attachment.
      const invoiceLine =
        `Final payment to release shipping: ${dollars(request.followupAmountCents)}.\n\n` +
        `Pay securely (Stripe): ${session.url}\n\n` +
        `As soon as this is paid we'll dispatch your package and email tracking. ` +
        `The receipt below shows how this number was calculated — items, sales tax, shipping, and the difference vs. your intake estimate.`;
      const chatBody = adminNote ? `${adminNote}\n\n${invoiceLine}` : invoiceLine;
      const receipt = await this.buildAndPostReceipt(id, user.sub, chatBody);

      const tpl = shopperFollowupOwedTemplate({
        reference: request.reference,
        threadToken: fresh,
        followupPayUrl: session.url,
        amountCents: request.followupAmountCents,
        receiptHtml: receipt.html || undefined,
        receiptText: receipt.text || undefined,
        receiptImageUrl: receipt.imageUrl,
      });
      void this.email.send({
        to: request.buyerEmail,
        subject: tpl.subject,
        html: tpl.html,
        text: tpl.text,
        idempotencyKey: `shopper:followup_email:${id}`,
        type: "shopper.followup_owed",
      });
      return { branch: "checkout" as const, payUrl: session.url };
    }

    if (request.followupAmountCents < 0) {
      // Negative delta — refund the difference.
      if (!request.intakeStripeIntentId) {
        throw new InternalServerErrorException({
          message: "Cannot issue refund — intake payment intent is missing.",
          code: "shopper_refund_no_intent",
        });
      }
      const refundAmount = -request.followupAmountCents;
      let refund: { refundId: string };
      try {
        refund = await this.stripe.refundShopperIntake({
          paymentIntentId: request.intakeStripeIntentId,
          amountCents: refundAmount,
          requestId: id,
          idempotencyKey: `shopper:refund:${id}`,
          reason: "requested_by_customer",
        });
      } catch (err) {
        this.logger.error(
          {
            err,
            requestId: id,
            errMessage: (err as Error)?.message,
            errName: (err as Error)?.name,
          },
          "shopper.followup.stripe_refund_failed",
        );
        throw new ServiceUnavailableException({
          message:
            "Couldn't issue the refund. Stripe may not be configured for this environment, or the Stripe API rejected the request — check the server logs and the Stripe dashboard.",
          code: "shopper_followup_refund_failed",
          stripeError: (err as Error)?.message ?? null,
        });
      }

      const updated = await this.requests.markFollowupRefunded({
        requestId: id,
        stripeRefundId: refund.refundId,
        actorId: user.sub,
      });

      // Refund confirmation + visual receipt. No URL to share here — Stripe
      // refunds settle directly back to the buyer's card. The receipt
      // attachment shows where the refund came from (actuals < estimate).
      const refundLine =
        `Refund issued: ${dollars(refundAmount)} back to your card.\n\n` +
        `Most banks settle within 5–10 business days. Your package will ship as soon as the warehouse picks it up — no further action needed. ` +
        `The receipt below shows how this refund was calculated.`;
      const chatBody = adminNote ? `${adminNote}\n\n${refundLine}` : refundLine;
      const receipt = await this.buildAndPostReceipt(id, user.sub, chatBody);

      const tpl = shopperRefundIssuedTemplate({
        reference: request.reference,
        threadToken: fresh,
        amountCents: refundAmount,
        receiptHtml: receipt.html || undefined,
        receiptText: receipt.text || undefined,
        receiptImageUrl: receipt.imageUrl,
      });
      void this.email.send({
        to: request.buyerEmail,
        subject: tpl.subject,
        html: tpl.html,
        text: tpl.text,
        idempotencyKey: `shopper:refund_email:${id}`,
        type: "shopper.refund_issued",
      });
      return { branch: "refund" as const, refundId: refund.refundId, status: updated.status };
    }

    // Zero delta — short-circuit straight to READY_TO_SHIP.
    const updated = await this.requests.markFollowupSkipped({ requestId: id, actorId: user.sub });
    const skipLine =
      `Reconciliation settled — actuals matched your intake estimate exactly. ` +
      `No further payment needed. Your package will ship as soon as the warehouse picks it up. ` +
      `The receipt below shows the full breakdown for your records.`;
    const chatBody = adminNote ? `${adminNote}\n\n${skipLine}` : skipLine;
    await this.buildAndPostReceipt(id, user.sub, chatBody);
    return { branch: "skipped" as const, status: updated.status };
  }

  // ---------------------------------------------------------------------------
  // Shipping
  // ---------------------------------------------------------------------------

  @Post(":id/ship")
  @HttpCode(HttpStatus.OK)
  async ship(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(adminShipShopperSchema)) body: AdminShipShopperInput,
  ) {
    const updated = await this.requests.markShipped({
      requestId: id,
      input: body,
      actorId: user.sub,
    });

    // Email the buyer with tracking. Token regenerated lazily — same logic
    // as in sendFollowup; we don't store plaintext. Receipt is included so
    // the buyer's last on-record email has the full breakdown attached.
    const fresh = (await this.tokens.issue(id)).plaintext;
    const request = await this.requests.getById(id, { includeLines: false });

    let receipt: { imageUrl: string | null; html: string; text: string } = {
      imageUrl: null,
      html: "",
      text: "",
    };
    try {
      const r = await this.receipts.generate(id);
      receipt = { imageUrl: r.imageUrl, html: r.html, text: r.text };
    } catch (err) {
      this.logger.warn({ err, requestId: id }, "shopper.ship.receipt_failed");
    }

    const tpl = shopperShippedTemplate({
      reference: request.reference,
      threadToken: fresh,
      carrier: body.carrier,
      trackingNumber: body.trackingNumber,
      receiptHtml: receipt.html || undefined,
      receiptText: receipt.text || undefined,
      receiptImageUrl: receipt.imageUrl,
    });
    void this.email.send({
      to: request.buyerEmail,
      subject: tpl.subject,
      html: tpl.html,
      text: tpl.text,
      idempotencyKey: `shopper:ship_email:${id}`,
      type: "shopper.shipped",
    });

    return updated;
  }

  /**
   * Migration 0025 — release on the buyer's own carrier label.
   *
   * Same end state as `/ship` (status moves to SHIPPED + tracking is
   * recorded) but the carrier + tracking come from the prepaid label
   * the buyer uploaded earlier, not from a Shippo purchase on our
   * account. The service refuses the call if the request isn't on
   * BUYER_FREIGHT or the label hasn't been uploaded.
   */
  @Post(":id/release-with-buyer-label")
  @HttpCode(HttpStatus.OK)
  async releaseWithBuyerLabel(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(adminReleaseWithBuyerLabelSchema))
    body: AdminReleaseWithBuyerLabelInput,
  ) {
    const updated = await this.requests.releaseWithBuyerLabel({
      requestId: id,
      input: body,
      actorId: user.sub,
    });
    // Same "shipped" email template as platform ship — the buyer gets
    // tracking + a fresh thread link. Generated lazily so we don't
    // store plaintext tokens.
    const fresh = (await this.tokens.issue(id)).plaintext;
    const request = await this.requests.getById(id, { includeLines: false });
    let receipt: { imageUrl: string | null; html: string; text: string } = {
      imageUrl: null,
      html: "",
      text: "",
    };
    try {
      const r = await this.receipts.generate(id);
      receipt = { imageUrl: r.imageUrl, html: r.html, text: r.text };
    } catch (err) {
      this.logger.warn(
        { err, requestId: id },
        "shopper.release_with_buyer_label.receipt_failed",
      );
    }
    const tpl = shopperShippedTemplate({
      reference: request.reference,
      threadToken: fresh,
      carrier: body.carrier,
      trackingNumber: body.trackingNumber,
      receiptHtml: receipt.html || undefined,
      receiptText: receipt.text || undefined,
      receiptImageUrl: receipt.imageUrl,
    });
    void this.email.send({
      to: request.buyerEmail,
      subject: tpl.subject,
      html: tpl.html,
      text: tpl.text,
      idempotencyKey: `shopper:release_buyer_label_email:${id}`,
      type: "shopper.shipped",
    });
    return updated;
  }

  /**
   * Migration 0025 — record an in-person pickup (PICKUP method only).
   *
   * Transitions READY_FOR_PICKUP → DELIVERED and stamps
   * pickupCompletedAt. Optional note lands in the chat thread so the
   * audit trail shows "delivered to authorized rep" or similar
   * deviation. No tracking number or carrier — there's no carrier
   * involved.
   */
  @Post(":id/mark-picked-up")
  @HttpCode(HttpStatus.OK)
  async markPickedUp(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(adminMarkPickedUpSchema)) body: AdminMarkPickedUpInput,
  ) {
    const updated = await this.requests.markPickedUp({
      requestId: id,
      input: body,
      actorId: user.sub,
    });
    // Surface the handoff in the buyer's chat thread + email so they
    // have an on-record confirmation. Best-effort — same pattern as
    // the other "background notification" calls.
    const note =
      "Your order has been picked up at the warehouse. " +
      "Thank you for using USA Errands!" +
      (body.note?.trim() ? `\n\n${body.note.trim()}` : "");
    try {
      await this.postAdminNote(id, note, user.sub);
    } catch (err) {
      this.logger.warn({ err, requestId: id }, "shopper.picked_up.note_failed");
    }
    return updated;
  }

  // ---------------------------------------------------------------------------
  // Migration 0023 — wire-track admin actions
  //
  // The four endpoints below drive the high-value (> wire threshold)
  // workflow. They're idempotent at the status-transition level — a
  // double-click produces a 409, not a corrupt row.
  // ---------------------------------------------------------------------------

  /**
   * Approve the buyer's gov-ID upload. Status moves to QUOTE_SENT, the
   * bank-instructions panel becomes visible to the buyer on the thread
   * page, and an optional admin note is posted to the chat thread.
   */
  @Post(":id/id/approve")
  @HttpCode(HttpStatus.OK)
  async approveId(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(adminApproveShopperIdSchema)) body: AdminApproveShopperIdInput,
  ) {
    const updated = await this.requests.approveIdVerification({
      requestId: id,
      actorId: user.sub,
      bankInstructions: body.bankInstructions,
    });
    // Surface the approval in the buyer's chat thread so they see the
    // "your ID has been verified — see bank instructions above" hint
    // alongside any admin note. When per-request bank instructions are
    // attached we also paste the account-number block directly into the
    // chat so the buyer doesn't have to switch tabs to grab it.
    //
    // Best-effort: a chat-post failure must not undo the approval.
    let note =
      (body.note?.trim() ? `${body.note.trim()}\n\n` : "") +
      "Your ID has been verified. The bank-transfer instructions are now visible on your request page. " +
      "Please make the transfer and upload your bank receipt when done.";
    if (body.bankInstructions) {
      const bi = body.bankInstructions;
      const lines: string[] = ["", "Wire to:"];
      if (bi.beneficiaryName) lines.push(`Beneficiary: ${bi.beneficiaryName}`);
      if (bi.bankName) lines.push(`Bank: ${bi.bankName}`);
      lines.push(`Account: ${bi.accountNumber}`);
      if (bi.routingNumber) lines.push(`Routing: ${bi.routingNumber}`);
      if (bi.swift) lines.push(`SWIFT/BIC: ${bi.swift}`);
      if (bi.iban) lines.push(`IBAN: ${bi.iban}`);
      if (bi.memo) lines.push(`Memo / reference: ${bi.memo}`);
      note += "\n" + lines.join("\n");
    }
    try {
      await this.postAdminNote(id, note, user.sub);
    } catch (err) {
      this.logger.warn({ err, requestId: id }, "shopper.id.approve.note_failed");
    }
    return updated;
  }

  /**
   * Reject the buyer's ID. The reason is sent to the buyer as a chat
   * message so they know exactly what to fix.
   */
  @Post(":id/id/reject")
  @HttpCode(HttpStatus.OK)
  async rejectId(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(adminRejectShopperIdSchema)) body: AdminRejectShopperIdInput,
  ) {
    const updated = await this.requests.rejectIdVerification({
      requestId: id,
      reason: body.reason,
      actorId: user.sub,
    });
    // Post the rejection reason directly to the chat so the buyer sees it.
    try {
      await this.postAdminNote(
        id,
        `We couldn't verify your ID. Reason: ${body.reason}\n\nPlease re-upload a clearer photo of your government-issued ID and a selfie holding it.`,
        user.sub,
      );
    } catch (err) {
      this.logger.warn({ err, requestId: id }, "shopper.id.reject.note_failed");
    }
    return updated;
  }

  /**
   * Confirm a wire-transfer payment. Status snaps to PROCURING (passing
   * through WIRE_CONFIRMED and PURCHASE_APPROVED in the audit log). An
   * optional admin note rides along on the chat thread.
   */
  @Post(":id/wire/confirm")
  @HttpCode(HttpStatus.OK)
  async confirmWire(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(adminConfirmShopperWireSchema)) body: AdminConfirmShopperWireInput,
  ) {
    this.assertFinanceRole(user);
    const updated = await this.requests.confirmWirePayment({
      requestId: id,
      actorId: user.sub,
    });
    const note =
      (body.note?.trim() ? `${body.note.trim()}\n\n` : "") +
      "Payment confirmed. We've started sourcing your items and will update you here as we go.";
    try {
      await this.postAdminNote(id, note, user.sub);
    } catch (err) {
      this.logger.warn({ err, requestId: id }, "shopper.wire.confirm.note_failed");
    }
    return updated;
  }

  /**
   * Reject the buyer's wire-transfer proof. Status returns to
   * AWAITING_WIRE_PAYMENT and the rejection reason is posted to chat so
   * the buyer can resubmit.
   */
  @Post(":id/wire/reject")
  @HttpCode(HttpStatus.OK)
  async rejectWire(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(adminRejectShopperWireSchema)) body: AdminRejectShopperWireInput,
  ) {
    this.assertFinanceRole(user);
    const updated = await this.requests.rejectWireProof({
      requestId: id,
      reason: body.reason,
      actorId: user.sub,
    });
    try {
      await this.postAdminNote(
        id,
        `We couldn't match your wire-transfer proof. Reason: ${body.reason}\n\nPlease re-upload a clearer bank receipt or contact us if you need help.`,
        user.sub,
      );
    } catch (err) {
      this.logger.warn({ err, requestId: id }, "shopper.wire.reject.note_failed");
    }
    return updated;
  }

  /**
   * Send the quote — convenience endpoint distinct from /id/approve.
   * In v1 approveId already moves the status to QUOTE_SENT, so this
   * endpoint exists to let admin re-send the quote message at any point
   * after that without changing the status. Useful when the buyer asks
   * for the bank details again or when a fresh chat reminder is wanted.
   */
  @Post(":id/quote/send")
  @HttpCode(HttpStatus.OK)
  async sendQuote(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(adminSendShopperQuoteSchema)) body: AdminSendShopperQuoteInput,
  ) {
    const request = await this.requests.getById(id, { includeLines: false });
    if (request.paymentMethod !== "WIRE") {
      throw new BadRequestException({
        message: "This request isn't on the wire-transfer track.",
        code: "shopper_wire_not_applicable",
      });
    }
    const thresholdCents = await loadWireThresholdCents(this.prisma, this.logger);
    if (!buyerIdCheckPassed(request, thresholdCents)) {
      throw new BadRequestException({
        message: "Approve the ID before sending the quote.",
        code: "shopper_quote_id_not_verified",
      });
    }
    const body0 =
      (body.message?.trim() ? `${body.message.trim()}\n\n` : "") +
      "Here's a quick reminder of the bank-transfer instructions for your order. The exact bank details are shown on your request page once your ID is approved — please include the reference in the wire memo so we can match the payment to your order.";
    await this.postAdminNote(id, body0, user.sub);
    return { status: request.status };
  }

  // ---------------------------------------------------------------------------
  // Cancel ± refund
  // ---------------------------------------------------------------------------

  /**
   * Cancel + (optional) refund. Correctness contract:
   *
   *   1. If buyer never paid intake → no refund possible, status flips to CANCELLED.
   *
   *   2. If buyer paid intake only → refund the *remaining refundable* on the
   *      intake intent. Remaining = intake_total − sum(prior succeeded/pending
   *      refunds against that intent). This handles the case where a
   *      negative-followup refund already moved part of the intake back, and
   *      avoids the "charge_already_refunded" 4xx that would otherwise lock
   *      the cancel.
   *
   *   3. If buyer also paid a positive followup → also refund the *remaining
   *      refundable* on the followup intent. Two separate Stripe Refund calls,
   *      separate idempotency keys, both refund ids persisted.
   *
   *   4. If a Stripe refund call hard-fails (network, auth, anything not
   *      "already refunded"), abort the cancel — the row stays in its current
   *      state so admin can retry without orphan refunds.
   *
   *   5. Idempotency keys are scoped per-direction (intake vs followup) and
   *      per-request, so a network retry from the admin's browser produces
   *      the SAME refund id rather than a second one.
   */
  @Post(":id/cancel")
  @HttpCode(HttpStatus.OK)
  async cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(adminCancelShopperSchema)) body: AdminCancelShopperInput,
  ) {
    this.assertFinanceRole(user);
    const request = await this.requests.getById(id, { includeLines: false });

    let intakeRefundId: string | null = null;
    let followupRefundId: string | null = null;
    let refundedAmountCents = 0;

    if (body.issueRefund) {
      // INTAKE refund — only meaningful if the buyer actually paid the intake.
      if (request.intakePaidAt && request.intakeStripeIntentId) {
        try {
          const alreadyRefunded = await this.stripe.getRefundedAmountForIntent(
            request.intakeStripeIntentId,
          );
          const remaining = request.intakeTotalCents - alreadyRefunded;
          if (remaining > 0) {
            const r = await this.stripe.refundShopperIntake({
              paymentIntentId: request.intakeStripeIntentId,
              amountCents: remaining,
              requestId: id,
              // Per-direction idempotency key. A second click from the admin
              // returns the same refund id rather than double-refunding.
              idempotencyKey: `shopper:cancel:intake:${id}`,
              reason: "requested_by_customer",
            });
            intakeRefundId = r.refundId;
            refundedAmountCents += remaining;
          }
          // remaining <= 0 means a prior refund already covered the intake;
          // nothing to do but record the cancel.
        } catch (err) {
          this.logger.error({ err, requestId: id }, "shopper.cancel.intake_refund_failed");
          throw new InternalServerErrorException({
            message:
              "Could not issue refund against the intake payment. The request was not cancelled.",
            code: "shopper_cancel_refund_failed",
            stage: "intake",
          });
        }
      }

      // FOLLOWUP refund — only when buyer paid a positive followup. The
      // negative-followup case (we issued a refund earlier) is handled
      // implicitly above because that refund is counted in alreadyRefunded.
      if (
        request.followupAmountCents != null &&
        request.followupAmountCents > 0 &&
        request.followupResolvedAt &&
        request.followupStripeIntentId
      ) {
        try {
          const alreadyRefunded = await this.stripe.getRefundedAmountForIntent(
            request.followupStripeIntentId,
          );
          const remaining = request.followupAmountCents - alreadyRefunded;
          if (remaining > 0) {
            const r = await this.stripe.refundShopperIntake({
              paymentIntentId: request.followupStripeIntentId,
              amountCents: remaining,
              requestId: id,
              idempotencyKey: `shopper:cancel:followup:${id}`,
              reason: "requested_by_customer",
            });
            followupRefundId = r.refundId;
            refundedAmountCents += remaining;
          }
        } catch (err) {
          // Intake may have already been refunded successfully above. We
          // don't try to "undo" it here — admin's choice to retry is safer
          // than us guessing. Status stays put; idempotency means the next
          // attempt won't re-refund the intake.
          this.logger.error({ err, requestId: id }, "shopper.cancel.followup_refund_failed");
          throw new InternalServerErrorException({
            message:
              "Could not issue refund against the follow-up payment. " +
              "Intake refund (if any) was issued; the follow-up refund must be retried " +
              "before the cancel finalises.",
            code: "shopper_cancel_refund_failed",
            stage: "followup",
            partialIntakeRefundId: intakeRefundId,
          });
        }
      }
    }

    return this.requests.cancel({
      requestId: id,
      reason: body.reason,
      actorId: user.sub,
      intakeRefundId,
      followupRefundId,
      refundedAmountCents,
    });
  }

  // ---------------------------------------------------------------------------
  // Chat
  // ---------------------------------------------------------------------------

  @Post(":id/messages")
  @HttpCode(HttpStatus.OK)
  async postMessage(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(postShopperMessageSchema)) body: PostShopperMessageInput,
  ) {
    const message = await this.messages.postFromAdmin({
      requestId: id,
      senderUserId: user.sub,
      body: body.body,
      attachmentUrls: body.attachmentUrls,
    });

    // Email the buyer that there's a new message — but only if there's an
    // existing thread URL to point them at. We mint a fresh token so the
    // email always works (the original token may be old / revoked).
    const fresh = (await this.tokens.issue(id)).plaintext;
    const request = await this.requests.getById(id, { includeLines: false });
    const tpl = shopperNewMessageTemplate({
      reference: request.reference,
      threadToken: fresh,
      preview: body.body,
    });
    void this.email.send({
      to: request.buyerEmail,
      subject: tpl.subject,
      html: tpl.html,
      text: tpl.text,
      // Idempotency at the per-message level — webhook replays of this
      // POST would never collide because the message id is fresh anyway.
      idempotencyKey: `shopper:msg_email:${message.id}`,
      type: "shopper.new_message",
    });

    return message;
  }

  @Post(":id/read")
  @HttpCode(HttpStatus.NO_CONTENT)
  markRead(@Param("id", new ParseUUIDPipe()) id: string): Promise<void> {
    return this.messages.markReadByAdmin(id);
  }

  // ---------------------------------------------------------------------------
  // Attachments — presign R2 upload for the admin chat composer
  // ---------------------------------------------------------------------------

  @Post(":id/uploads")
  @HttpCode(HttpStatus.OK)
  async presignUpload(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(presignShopperUploadSchema))
    body: PresignShopperUploadInput,
  ) {
    // Confirm the request exists so an admin can't generate a key for a
    // bogus id. (`getById` throws 404 on miss.)
    await this.requests.getById(id, { includeLines: false });
    const key = this.r2.generateKey(`shopper/${id}/admin`, body.filename);
    return this.r2.presignPut({
      key,
      contentType: body.contentType,
      contentLengthBytes: body.contentLengthBytes,
    });
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Freight rates — per-method cents/lb. Read from configuration row
  // `shopper_freight_rates`. Used by setShipping AND surfaced to the
  // admin shipping form (live cost preview) via GET /freight-rates.
  // ---------------------------------------------------------------------------

  /**
   * GET /v1/admin/shopper/freight-rates
   *
   * Phase 2 redesign — the per-request rate is now typed inline on the
   * shopper detail page so this endpoint exists only to hand back the
   * canonical method ordering + last-known default rates (used to
   * pre-fill the rate input when admin first opens the shipping form).
   */
  @Get("freight-rates")
  async listFreightRates(): Promise<{
    rates: Record<string, number>;
    methods: ReadonlyArray<string>;
  }> {
    const rates = await this.loadFreightRates();
    return {
      rates,
      methods: ["PLATFORM_FREIGHT", "BUYER_FORWARDER", "PICKUP"] as const,
    };
  }

  private async loadFreightRates(): Promise<Record<string, number>> {
    try {
      const row = await this.prisma.configuration.findUnique({
        where: { key: "shopper_freight_rates" },
      });
      if (!row) {
        // Defaults match the migration 0017 seed values. If the row
        // was deleted, surface sensible numbers rather than $0/lb
        // across the board (which would let real shipments through
        // free of charge).
        return { PLATFORM_FREIGHT: 450, BUYER_FORWARDER: 200, PICKUP: 0 };
      }
      const value = row.value as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        this.logger.warn({ value }, "shopper_freight_rates: not an object, falling back");
        return { PLATFORM_FREIGHT: 450, BUYER_FORWARDER: 200, PICKUP: 0 };
      }
      const out: Record<string, number> = {};
      for (const [k, v] of Object.entries(value)) {
        const n = typeof v === "number" ? v : Number(v);
        // Cap at $1,000/lb — way above any sane freight tier; protects
        // against a typo turning a $4.50/lb rate into $450/lb.
        if (Number.isFinite(n) && n >= 0 && n <= 100_000) {
          out[k] = Math.round(n);
        } else {
          this.logger.warn({ method: k, value: v }, "shopper_freight_rates: skipping invalid entry");
        }
      }
      return out;
    } catch (err) {
      this.logger.error({ err }, "shopper.freight_rates_load_failed");
      // Don't fail the action — the service handles missing methods
      // by treating the rate as 0, which fails noisily on the auto-
      // calc path and silently no-ops on the override path.
      return {};
    }
  }

  private assertFinanceRole(user: AuthenticatedUser): void {
    if (!FINANCE_ROLES.includes(user.role as (typeof FINANCE_ROLES)[number])) {
      throw new ForbiddenException({
        message: "Finance permission required for this action.",
        code: "shopper_finance_only",
      });
    }
  }

  private async postAdminNote(
    requestId: string,
    body: string,
    actorId: string,
    attachmentUrls: string[] = [],
  ): Promise<void> {
    await this.messages.postFromAdmin({
      requestId,
      senderUserId: actorId,
      body,
      attachmentUrls: attachmentUrls.length > 0 ? attachmentUrls : undefined,
    });
  }

  /**
   * Generate the receipt, post it as a chat attachment with a system note,
   * and return the rendered fragments so the caller can embed them in
   * an email. Best-effort: receipt failures never break the action.
   *
   * The returned `imageUrl` may be null if R2 isn't configured. The
   * `html` and `text` fragments are always populated.
   */
  private async buildAndPostReceipt(
    requestId: string,
    actorId: string,
    note: string,
  ): Promise<{ imageUrl: string | null; html: string; text: string }> {
    try {
      const rendered = await this.receipts.generate(requestId);
      // Post the chat note + image attachment together so the thread
      // shows the explanation and the visual receipt as one item.
      const attachments = rendered.imageUrl ? [rendered.imageUrl] : [];
      await this.postAdminNote(requestId, note, actorId, attachments);
      return { imageUrl: rendered.imageUrl, html: rendered.html, text: rendered.text };
    } catch (err) {
      this.logger.warn(
        { err, requestId },
        "shopper.receipt.build_or_post_failed",
      );
      return { imageUrl: null, html: "", text: "" };
    }
  }

  /**
   * We can't recover plaintext from a stored sha256 hash. This helper exists
   * as a placeholder for a future "show last issued plaintext until first
   * use" pattern. For now, callers fall back to issuing a fresh token —
   * each magic-link is independently valid and tracked, so issuing more
   * doesn't compromise security; it just means the buyer ends up with
   * multiple working URLs.
   */
  private async findActiveTokenPlaintextHint(_requestId: string): Promise<string | null> {
    return null;
  }
}
