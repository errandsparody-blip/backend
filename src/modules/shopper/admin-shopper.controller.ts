/**
 * Admin Shopper controller — operator + finance endpoints.
 *
 *   GET    /v1/admin/shopper                          — queue / list
 *   GET    /v1/admin/shopper/:id                      — full detail (incl. messages)
 *   POST   /v1/admin/shopper/:id/start                — PAID → PROCURING
 *   PATCH  /v1/admin/shopper/:id/lines/:lineId        — set actuals + status
 *   POST   /v1/admin/shopper/:id/shipping             — set shipping cost + method
 *   POST   /v1/admin/shopper/:id/finalize             — compute follow-up + transition
 *   POST   /v1/admin/shopper/:id/followup/send        — issue Checkout (positive) /
 *                                                      Refund (negative) / skip (zero)
 *   POST   /v1/admin/shopper/:id/ship                 — attach carrier + tracking
 *   POST   /v1/admin/shopper/:id/cancel               — cancel ± refund
 *   POST   /v1/admin/shopper/:id/messages             — admin posts to thread
 *   POST   /v1/admin/shopper/:id/read                 — admin marks buyer messages read
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
  adminCancelShopperSchema,
  adminListShopperRequestsSchema,
  adminSendFollowupSchema,
  adminSetShopperShippingSchema,
  adminShipShopperSchema,
  adminUpdateShopperLineSchema,
  postShopperMessageSchema,
  presignShopperUploadSchema,
  type AdminCancelShopperInput,
  type AdminListShopperRequestsInput,
  type AdminSendFollowupInput,
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
} from "../email/email-templates";
import { R2Service } from "../integrations/r2/r2.service";
import { StripeService } from "../integrations/stripe/stripe.service";

import { ShopperMessageService } from "./shopper-message.service";
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
  setShipping(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(adminSetShopperShippingSchema))
    body: AdminSetShopperShippingInput,
  ) {
    return this.requests.setShipping({ requestId: id, input: body, actorId: user.sub });
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

      // Post the invoice into the chat thread so the buyer sees it the
      // moment they open the page — not only in email. The combined body
      // includes any optional admin note up top, then the system-
      // generated invoice text + Stripe link.
      const invoiceLine =
        `Final payment to release shipping: ${dollars(request.followupAmountCents)}.\n\n` +
        `Pay securely (Stripe): ${session.url}\n\n` +
        `As soon as this is paid we'll dispatch your package and email tracking.`;
      const chatBody = adminNote ? `${adminNote}\n\n${invoiceLine}` : invoiceLine;
      try {
        await this.postAdminNote(id, chatBody, user.sub);
      } catch (err) {
        // Best-effort — the canonical record of the invoice is the
        // Stripe session itself + the email we send below. A chat-post
        // failure shouldn't block the response or rewind the Stripe
        // session.
        this.logger.warn({ err, requestId: id }, "shopper.followup.chat_post_failed");
      }

      const tpl = shopperFollowupOwedTemplate({
        reference: request.reference,
        threadToken: fresh,
        followupPayUrl: session.url,
        amountCents: request.followupAmountCents,
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

      // Refund confirmation in the chat. No URL to share here — Stripe
      // refunds settle directly back to the buyer's card.
      const refundLine =
        `Refund issued: ${dollars(refundAmount)} back to your card.\n\n` +
        `Most banks settle within 5–10 business days. Your package will ship as soon as the warehouse picks it up — no further action needed.`;
      const chatBody = adminNote ? `${adminNote}\n\n${refundLine}` : refundLine;
      try {
        await this.postAdminNote(id, chatBody, user.sub);
      } catch (err) {
        this.logger.warn({ err, requestId: id }, "shopper.refund.chat_post_failed");
      }

      const tpl = shopperRefundIssuedTemplate({
        reference: request.reference,
        threadToken: fresh,
        amountCents: refundAmount,
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
      `No further payment needed. Your package will ship as soon as the warehouse picks it up.`;
    const chatBody = adminNote ? `${adminNote}\n\n${skipLine}` : skipLine;
    try {
      await this.postAdminNote(id, chatBody, user.sub);
    } catch (err) {
      this.logger.warn({ err, requestId: id }, "shopper.skipped.chat_post_failed");
    }
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
    // as in sendFollowup; we don't store plaintext.
    const fresh = (await this.tokens.issue(id)).plaintext;
    const request = await this.requests.getById(id, { includeLines: false });
    const tpl = shopperShippedTemplate({
      reference: request.reference,
      threadToken: fresh,
      carrier: body.carrier,
      trackingNumber: body.trackingNumber,
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

  private assertFinanceRole(user: AuthenticatedUser): void {
    if (!FINANCE_ROLES.includes(user.role as (typeof FINANCE_ROLES)[number])) {
      throw new ForbiddenException({
        message: "Finance permission required for this action.",
        code: "shopper_finance_only",
      });
    }
  }

  private async postAdminNote(requestId: string, body: string, actorId: string): Promise<void> {
    await this.messages.postFromAdmin({ requestId, senderUserId: actorId, body });
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
