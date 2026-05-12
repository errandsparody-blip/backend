/**
 * Public Shopper controller — buyer-facing endpoints.
 *
 *   POST   /v1/shopper                          — create request + intake Checkout
 *   GET    /v1/shopper/r/:token                 — resolve magic-link → thread snapshot
 *   POST   /v1/shopper/r/:token/messages        — buyer posts a chat message
 *   POST   /v1/shopper/r/:token/read            — bulk-mark admin messages as read
 *
 * All routes are @Public (no JWT). Authentication for /r/:token endpoints
 * is the magic-link token itself — the controller resolves it via
 * ShopperTokenService and trusts the resulting requestId.
 *
 * Rate limiting: stricter on POST endpoints to make scraping/spam expensive.
 */

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  InternalServerErrorException,
  Logger,
  Param,
  Post,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";

import { loadConfig } from "../../common/config";
import { Public } from "../../common/decorators/public.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { PrismaService } from "../../common/prisma.service";
import {
  createShopperRequestSchema,
  postShopperMessageSchema,
  presignShopperUploadSchema,
  submitShopperIdUploadsSchema,
  submitShopperWireProofSchema,
  type CreateShopperRequestInput,
  type PostShopperMessageInput,
  type PresignShopperUploadInput,
  type SubmitShopperIdUploadsInput,
  type SubmitShopperWireProofInput,
} from "../../common/schemas/shopper.schema";
import { EmailService } from "../email/email.service";
import {
  opsBuyerMessageTemplate,
  opsNewShopperRequestTemplate,
  shopperIntakeReceivedTemplate,
} from "../email/email-templates";
import { OpsAlertService } from "../notifications/ops-alert.service";
import { R2Service } from "../integrations/r2/r2.service";
import { StripeService } from "../integrations/stripe/stripe.service";

import { ShopperMessageService } from "./shopper-message.service";
import { ShopperRequestService } from "./shopper-request.service";
import { ShopperTokenService } from "./shopper-token.service";

const COMMISSION_CONFIG_KEY = "shopper_commission_bps";
const COMMISSION_DEFAULT_BPS = 1800;
const COMMISSION_MAX_BPS = 10_000;
const TAX_RATES_CONFIG_KEY = "shopper_tax_rates";
const WAREHOUSE_STATE_CONFIG_KEY = "shopper_warehouse_state";
// Texas combined-average rate, used as fallback when the warehouse-state
// row is missing or the resolved state isn't in the tax-rate map.
const FALLBACK_WAREHOUSE_STATE = "TX";
const FALLBACK_TAX_BPS = 825;
// Migration 0023 — items-subtotal threshold above which a buyer is routed
// onto the wire-transfer + ID-verification track. Configurable via the
// `shopper_wire_threshold_cents` row; fallback used only if the row is
// missing (fresh dev environments that haven't run migration 0023 yet).
const WIRE_THRESHOLD_CONFIG_KEY = "shopper_wire_threshold_cents";
const WIRE_THRESHOLD_FALLBACK_CENTS = 100_000; // $1,000
// Cap on the threshold so a misconfigured row can't push the wire flow
// effectively off (e.g. a billion-cent threshold) or shrink it to a few
// dollars by accident.
const WIRE_THRESHOLD_MAX_CENTS = 10_000_000; // $100,000
const BANK_INSTRUCTIONS_CONFIG_KEY = "shopper_bank_instructions";

@Controller({ path: "shopper", version: "1" })
export class ShopperController {
  private readonly logger = new Logger(ShopperController.name);

  constructor(
    private readonly requests: ShopperRequestService,
    private readonly messages: ShopperMessageService,
    private readonly tokens: ShopperTokenService,
    private readonly stripe: StripeService,
    private readonly email: EmailService,
    private readonly prisma: PrismaService,
    private readonly r2: R2Service,
    private readonly opsAlerts: OpsAlertService,
  ) {}

  // ---------------------------------------------------------------------------
  // POST /v1/shopper — create request + intake Checkout session
  // ---------------------------------------------------------------------------

  @Public()
  @Post()
  @HttpCode(HttpStatus.OK)
  // 5 requests per buyer-IP-window. Generous enough for UX, hostile to scripts.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async create(
    @Body(new ZodValidationPipe(createShopperRequestSchema)) body: CreateShopperRequestInput,
  ): Promise<{
    requestId: string;
    reference: string;
    threadUrl: string;
    // Migration 0023 — empty string when the buyer was routed to WIRE.
    // The frontend already refuses to navigate to anything not starting
    // with https://, so an empty string keeps it on /shopper/r/<token>.
    payUrl: string;
    intakeTotalCents: number;
    paymentMethod: "STRIPE" | "WIRE";
  }> {
    const cfg = loadConfig();
    const commissionBps = await this.loadCommissionBps();
    // Migration 0023 — load the wire threshold AFTER computing the items
    // subtotal (we'd need to validate the lines first either way; doing
    // the lookup up here keeps the create-call atomic).
    const wireThresholdCents = await this.loadWireThresholdCents();

    // Resolve the effective tax state for this request. The retailer ships
    // to whoever's address gets put on the order — that's our warehouse
    // unless the buyer is using their own forwarder, in which case we use
    // the forwarder's state (when supplied at intake).
    const taxRates = await this.loadTaxRates();
    const warehouseState = await this.loadWarehouseState();
    const buyerAddrState =
      body.shippingAddress?.state && /^[A-Z]{2}$/.test(body.shippingAddress.state)
        ? body.shippingAddress.state
        : null;
    // For now, always use the warehouse state — we don't yet expose the
    // shipping-method choice on the intake form. When BUYER_FORWARDER lands,
    // the address.state above is the right input.
    const effectiveTaxState = warehouseState;
    void buyerAddrState; // referenced when forwarder support lands
    const estimatedTaxBps =
      taxRates[effectiveTaxState] ??
      (effectiveTaxState === FALLBACK_WAREHOUSE_STATE ? FALLBACK_TAX_BPS : 0);

    // Migration 0023 — decide the rail BEFORE creating the row so the
    // initial status is correct and we don't have to mutate-after-create
    // (which would race with the chat-message insert below).
    //
    // The check is on the items subtotal alone, NOT the intake total,
    // because the threshold is the buyer-visible "your cart" number.
    // Adding commission + tax in here would silently push borderline
    // carts onto the wire flow even when the buyer thinks they're under.
    const itemsSubtotalForRailCents = body.lines.reduce(
      (sum, line) => sum + line.estimatedUnitPriceCents * line.quantity,
      0,
    );
    const paymentMethod: "STRIPE" | "WIRE" =
      itemsSubtotalForRailCents >= wireThresholdCents ? "WIRE" : "STRIPE";

    // 1. Persist request. Status is set inside requests.create() based on
    //    paymentMethod (AWAITING_INTAKE_PAYMENT for STRIPE,
    //    AWAITING_ID_VERIFICATION for WIRE).
    const created = await this.requests.create(body, {
      commissionBps,
      estimatedTaxBps,
      effectiveTaxState,
      paymentMethod,
    });

    // 2. Mint a magic-link token for the buyer to access the thread.
    const issued = await this.tokens.issue(created.id);

    // 3. If the buyer added an initial message, post it as the first chat row.
    if (body.initialMessage && body.initialMessage.trim().length > 0) {
      await this.messages.postFromBuyer({
        requestId: created.id,
        body: body.initialMessage.trim(),
      });
    }

    // Resolve the optional parent reference for both the buyer email and
    // the ops alert. Best-effort — a missing parent reference shouldn't
    // block the intake from succeeding.
    let parentReference: string | null = null;
    if (created.parentRequestId) {
      const parentRow = await this.requests
        .getById(created.parentRequestId, { includeLines: false })
        .catch(() => null);
      parentReference = parentRow?.reference ?? null;
    }

    // ============================================================
    // BRANCH — Stripe rail (unchanged from v1)
    // ============================================================

    if (paymentMethod === "STRIPE") {
      let session: { sessionId: string; paymentIntentId: string | null; url: string };
      try {
        session = await this.stripe.createShopperIntakeSession({
          requestId: created.id,
          buyerEmail: created.buyerEmail,
          itemsSubtotalCents: created.itemsSubtotalCents,
          commissionCents: created.commissionCents,
          estimatedTaxCents: created.estimatedTaxCents,
          idempotencyKey: `shopper:intake:${created.id}`,
          successUrl: `${cfg.WEB_PUBLIC_URL}/shopper/r/${encodeURIComponent(issued.plaintext)}?paid=1`,
          cancelUrl: `${cfg.WEB_PUBLIC_URL}/shopper/r/${encodeURIComponent(issued.plaintext)}?cancelled=1`,
        });
      } catch (err) {
        // Stripe outage during intake. The request is already saved
        // with status AWAITING_INTAKE_PAYMENT; the buyer can retry from
        // the thread page.
        this.logger.error({ err, requestId: created.id }, "shopper.intake.stripe_failed");
        throw new InternalServerErrorException({
          message: "Could not start payment. Please try again.",
          code: "shopper_stripe_unavailable",
        });
      }

      await this.requests.attachIntakeSession(
        created.id,
        session.sessionId,
        session.paymentIntentId,
      );

      const tpl = shopperIntakeReceivedTemplate({
        reference: created.reference,
        parentReference,
        threadToken: issued.plaintext,
        intakePayUrl: session.url,
        intakeTotalCents: created.intakeTotalCents,
      });
      void this.email.send({
        to: created.buyerEmail,
        subject: tpl.subject,
        html: tpl.html,
        text: tpl.text,
        idempotencyKey: `shopper:intake_email:${created.id}`,
        type: "shopper.intake_received",
      });

      const ops = opsNewShopperRequestTemplate({
        requestId: created.id,
        reference: created.reference,
        parentReference,
        buyerEmail: created.buyerEmail,
        itemsCount: created.lines.length,
        intakeTotalCents: created.intakeTotalCents,
      });
      void this.opsAlerts
        .send({
          type: "ops.shopper.request",
          subject: ops.subject,
          html: ops.html,
          text: ops.text,
          idempotencyKey: `ops:shopper:new:${created.id}`,
          href: `/admin/shopper/${created.id}`,
        })
        .catch(() => undefined);

      return {
        requestId: created.id,
        reference: created.reference,
        threadUrl: `${cfg.WEB_PUBLIC_URL}/shopper/r/${encodeURIComponent(issued.plaintext)}`,
        payUrl: session.url,
        intakeTotalCents: created.intakeTotalCents,
        paymentMethod: "STRIPE",
      };
    }

    // ============================================================
    // BRANCH — WIRE rail
    //
    // Skip Stripe entirely. The buyer lands on their thread page, which
    // surfaces the ID-upload prompt. Bank-transfer instructions stay
    // hidden until admin approves the ID and issues a quote.
    //
    // We still email the buyer so they have the magic link, and we still
    // fire the ops alert so the admin team knows a high-value request
    // arrived. The email subject + body is tailored to the wire flow so
    // the buyer doesn't get confused looking for a Stripe link.
    // ============================================================

    const wireTpl = shopperIntakeReceivedTemplate({
      reference: created.reference,
      parentReference,
      threadToken: issued.plaintext,
      // No Stripe URL on the WIRE rail. The template swaps the
      // call-to-action to "open your private order page" and walks the
      // buyer through the two-step ID-then-wire flow.
      intakePayUrl: "",
      intakeTotalCents: created.intakeTotalCents,
      paymentMethod: "WIRE",
    });
    void this.email.send({
      to: created.buyerEmail,
      subject: wireTpl.subject,
      html: wireTpl.html,
      text: wireTpl.text,
      idempotencyKey: `shopper:intake_email:${created.id}`,
      type: "shopper.intake_received",
    });

    const wireOps = opsNewShopperRequestTemplate({
      requestId: created.id,
      reference: created.reference,
      parentReference,
      buyerEmail: created.buyerEmail,
      itemsCount: created.lines.length,
      intakeTotalCents: created.intakeTotalCents,
    });
    void this.opsAlerts
      .send({
        type: "ops.shopper.request",
        subject: `[WIRE] ${wireOps.subject}`,
        html: wireOps.html,
        text: wireOps.text,
        idempotencyKey: `ops:shopper:new:${created.id}`,
        href: `/admin/shopper/${created.id}`,
        // Wire-track requests need an operator's eyes — bump to WARNING
        // so the badge reads as actionable, not informational.
        severity: "WARNING",
      })
      .catch(() => undefined);

    return {
      requestId: created.id,
      reference: created.reference,
      threadUrl: `${cfg.WEB_PUBLIC_URL}/shopper/r/${encodeURIComponent(issued.plaintext)}`,
      payUrl: "",
      intakeTotalCents: created.intakeTotalCents,
      paymentMethod: "WIRE",
    };
  }

  // ---------------------------------------------------------------------------
  // GET /v1/shopper/r/:token — buyer thread snapshot
  // ---------------------------------------------------------------------------

  @Public()
  @Get("r/:token")
  // Generous limit — buyers refresh while waiting for an admin reply, but
  // anonymous traffic could DoS by guessing tokens. 60/min is well above
  // a polling client (we expect 0.5/min from a focused tab).
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async getThread(@Param("token") token: string) {
    const resolved = await this.tokens.resolve(token);
    const request = await this.requests.getById(resolved.requestId);
    const messageRows = await this.messages.listForRequest(resolved.requestId);

    // Resolve the parent reference (UUID → SHP-XXXXX) for buyer display.
    let parentReference: string | null = null;
    if (request.parentRequestId) {
      const parentRow = await this.requests
        .getById(request.parentRequestId, { includeLines: false })
        .catch(() => null);
      parentReference = parentRow?.reference ?? null;
    }

    // Migration 0023 — bank instructions are NEVER rendered on the
    // intake form. They only ride along on the thread response when:
    //   1. payment_method is WIRE,
    //   2. ID is APPROVED, and
    //   3. status is past the quote-sending step.
    // Defensive gating in addition to the screen-level check on the
    // client — keeps the bank details out of any debug payload an
    // unverified buyer might capture.
    const bankRevealStatuses = new Set([
      "QUOTE_SENT",
      "AWAITING_WIRE_PAYMENT",
      "WIRE_PROOF_UPLOADED",
      "WIRE_UNDER_REVIEW",
    ]);
    const shouldRevealBank =
      request.paymentMethod === "WIRE" &&
      request.idVerificationStatus === "APPROVED" &&
      bankRevealStatuses.has(request.status as string);

    const bankInstructions = shouldRevealBank ? await this.loadBankInstructions() : null;

    return {
      request: {
        ...this.serializeBuyerRequest(request),
        parentReference,
        // Surface the bank instructions only on the wire-payment leg.
        // Null otherwise so the client UI never accidentally renders.
        bankInstructions,
      },
      messages: messageRows.map((m) => ({
        id: m.id,
        sender: m.sender,
        body: m.body,
        attachmentUrls: m.attachmentUrls,
        createdAt: m.createdAt,
        // Buyers don't get to see admin user identity beyond "ADMIN".
      })),
    };
  }

  // ---------------------------------------------------------------------------
  // POST /v1/shopper/r/:token/messages — buyer posts to the thread
  // ---------------------------------------------------------------------------

  @Public()
  @Post("r/:token/messages")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async postMessage(
    @Param("token") token: string,
    @Body(new ZodValidationPipe(postShopperMessageSchema)) body: PostShopperMessageInput,
  ) {
    const resolved = await this.tokens.resolve(token);
    const message = await this.messages.postFromBuyer({
      requestId: resolved.requestId,
      body: body.body,
      attachmentUrls: body.attachmentUrls,
    });

    // Ops alert — admin team should know a buyer is waiting on a reply.
    // Look up the buyer's email so the alert subject is useful.
    const request = await this.requests.getById(resolved.requestId, { includeLines: false });
    const ops = opsBuyerMessageTemplate({
      requestId: resolved.requestId,
      reference: request.reference,
      buyerEmail: request.buyerEmail,
      preview: body.body,
    });
    void this.opsAlerts
      .send({
        type: "ops.shopper.buyer_message",
        subject: ops.subject,
        html: ops.html,
        text: ops.text,
        // Per-message dedupe — a webhook replay won't double-alert.
        idempotencyKey: `ops:shopper:msg:${message.id}`,
        href: `/admin/shopper/${resolved.requestId}`,
      })
      .catch(() => undefined);

    return {
      id: message.id,
      sender: message.sender,
      body: message.body,
      attachmentUrls: message.attachmentUrls,
      createdAt: message.createdAt,
    };
  }

  // ---------------------------------------------------------------------------
  // POST /v1/shopper/r/:token/uploads — presign R2 attachment upload
  // ---------------------------------------------------------------------------
  //
  // The token-resolve check ties the upload to a specific request so a
  // presigned URL can't be generated without first proving access to a
  // valid thread. We further scope the R2 key under the requestId so a
  // forensic search by request id surfaces every attached file.

  @Public()
  @Post("r/:token/uploads")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async presignUpload(
    @Param("token") token: string,
    @Body(new ZodValidationPipe(presignShopperUploadSchema))
    body: PresignShopperUploadInput,
  ) {
    const resolved = await this.tokens.resolve(token);
    const key = this.r2.generateKey(`shopper/${resolved.requestId}/buyer`, body.filename);
    const presigned = this.r2.presignPut({
      key,
      contentType: body.contentType,
      contentLengthBytes: body.contentLengthBytes,
    });
    return presigned;
  }

  // ---------------------------------------------------------------------------
  // Migration 0023 — wire-track buyer endpoints
  // ---------------------------------------------------------------------------

  /**
   * Presign a PUT for the ID document or selfie. Same shape as the chat
   * uploads endpoint but the R2 key prefix lives under `id/` so an
   * admin-side audit by request id can distinguish KYC artefacts from
   * chat attachments at a glance.
   *
   * Refuses to presign unless the request is on the WIRE rail and in a
   * state where ID uploads are expected — defence in depth even though
   * the URL is gated by a magic-link token.
   */
  @Public()
  @Post("r/:token/id-uploads")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async presignIdUpload(
    @Param("token") token: string,
    @Body(new ZodValidationPipe(presignShopperUploadSchema))
    body: PresignShopperUploadInput,
  ) {
    const resolved = await this.tokens.resolve(token);
    const request = await this.requests.getById(resolved.requestId, { includeLines: false });
    if (request.paymentMethod !== "WIRE") {
      throw new BadRequestException({
        message: "This request doesn't require ID verification.",
        code: "shopper_id_not_required",
      });
    }
    const allowed = ["AWAITING_ID_VERIFICATION", "ID_UNDER_REVIEW"];
    if (
      !allowed.includes(request.status as string) &&
      request.idVerificationStatus !== "REJECTED"
    ) {
      throw new BadRequestException({
        message: "ID can no longer be re-uploaded at this stage.",
        code: "shopper_id_locked",
        status: request.status,
        idVerificationStatus: request.idVerificationStatus,
      });
    }
    const key = this.r2.generateKey(`shopper/${resolved.requestId}/id`, body.filename);
    return this.r2.presignPut({
      key,
      contentType: body.contentType,
      contentLengthBytes: body.contentLengthBytes,
    });
  }

  /**
   * Buyer submits the URLs of the ID document + selfie they just PUT'd
   * to R2. The server validates the URLs belong to OUR R2 bucket and
   * advances the request to ID_UNDER_REVIEW.
   */
  @Public()
  @Post("r/:token/id-submit")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async submitIdUploads(
    @Param("token") token: string,
    @Body(new ZodValidationPipe(submitShopperIdUploadsSchema))
    body: SubmitShopperIdUploadsInput,
  ) {
    const resolved = await this.tokens.resolve(token);
    this.assertUrlBelongsToOurBucket(body.idDocumentUrl);
    this.assertUrlBelongsToOurBucket(body.idSelfieUrl);
    const updated = await this.requests.submitIdUploads({
      requestId: resolved.requestId,
      idDocumentUrl: body.idDocumentUrl,
      idSelfieUrl: body.idSelfieUrl,
    });

    // Ops alert — admin team needs to review the ID. Best-effort.
    void this.opsAlerts
      .send({
        type: "ops.shopper.id_submitted",
        subject: `[WIRE] ID submitted — ${updated.reference}`,
        html: `<p>Buyer <strong>${this.escapeHtml(updated.buyerEmail)}</strong> uploaded ID for ${this.escapeHtml(updated.reference)}. Review at the admin shopper page.</p>`,
        text: `Buyer ${updated.buyerEmail} uploaded ID for ${updated.reference}. Review in admin.`,
        idempotencyKey: `ops:shopper:id_submitted:${updated.id}`,
        href: `/admin/shopper/${updated.id}`,
        severity: "WARNING",
      })
      .catch(() => undefined);

    return {
      status: updated.status,
      idVerificationStatus: updated.idVerificationStatus,
    };
  }

  /**
   * Presign a PUT for the wire-transfer proof (bank receipt / screenshot).
   * Refuses to presign unless ID is APPROVED and the request is in a
   * state expecting wire proof.
   */
  @Public()
  @Post("r/:token/wire-proof-uploads")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async presignWireProofUpload(
    @Param("token") token: string,
    @Body(new ZodValidationPipe(presignShopperUploadSchema))
    body: PresignShopperUploadInput,
  ) {
    const resolved = await this.tokens.resolve(token);
    const request = await this.requests.getById(resolved.requestId, { includeLines: false });
    if (request.paymentMethod !== "WIRE") {
      throw new BadRequestException({
        message: "This request isn't on the wire-transfer track.",
        code: "shopper_wire_not_applicable",
      });
    }
    if (request.idVerificationStatus !== "APPROVED") {
      throw new BadRequestException({
        message: "ID must be approved before uploading wire proof.",
        code: "shopper_wire_id_not_verified",
      });
    }
    const allowed = ["QUOTE_SENT", "AWAITING_WIRE_PAYMENT", "WIRE_PROOF_UPLOADED", "WIRE_UNDER_REVIEW"];
    if (!allowed.includes(request.status as string)) {
      throw new BadRequestException({
        message: "Wire proof can only be uploaded after we've sent your quote.",
        code: "shopper_wire_proof_invalid_state",
        status: request.status,
      });
    }
    const key = this.r2.generateKey(`shopper/${resolved.requestId}/wire`, body.filename);
    return this.r2.presignPut({
      key,
      contentType: body.contentType,
      contentLengthBytes: body.contentLengthBytes,
    });
  }

  /**
   * Buyer submits the URL of the wire-transfer proof. Advances the
   * request to WIRE_UNDER_REVIEW so admin can confirm.
   */
  @Public()
  @Post("r/:token/wire-proof-submit")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async submitWireProof(
    @Param("token") token: string,
    @Body(new ZodValidationPipe(submitShopperWireProofSchema))
    body: SubmitShopperWireProofInput,
  ) {
    const resolved = await this.tokens.resolve(token);
    this.assertUrlBelongsToOurBucket(body.wireProofUrl);
    const updated = await this.requests.submitWireProof({
      requestId: resolved.requestId,
      wireProofUrl: body.wireProofUrl,
    });

    void this.opsAlerts
      .send({
        type: "ops.shopper.wire_proof_submitted",
        subject: `[WIRE] Payment proof submitted — ${updated.reference}`,
        html: `<p>Buyer <strong>${this.escapeHtml(updated.buyerEmail)}</strong> submitted wire-transfer proof for ${this.escapeHtml(updated.reference)}.</p>`,
        text: `Buyer ${updated.buyerEmail} submitted wire-transfer proof for ${updated.reference}.`,
        idempotencyKey: `ops:shopper:wire_submitted:${updated.id}`,
        href: `/admin/shopper/${updated.id}`,
        severity: "WARNING",
      })
      .catch(() => undefined);

    return { status: updated.status };
  }

  // ---------------------------------------------------------------------------
  // POST /v1/shopper/r/:token/read — buyer marks admin messages as read
  // ---------------------------------------------------------------------------

  @Public()
  @Post("r/:token/read")
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async markRead(@Param("token") token: string): Promise<void> {
    const resolved = await this.tokens.resolve(token);
    await this.messages.markReadByBuyer(resolved.requestId);
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Pull the commission rate from the configuration table. Falls back to a
   * compiled-in default ONLY if the row is missing — abnormal in production
   * (the migration seeded it) but useful in dev environments where someone
   * may have wiped configuration during testing.
   */
  private async loadCommissionBps(): Promise<number> {
    try {
      const row = await this.prisma.configuration.findUnique({
        where: { key: COMMISSION_CONFIG_KEY },
      });
      if (!row) return COMMISSION_DEFAULT_BPS;
      const value = row.value as unknown;
      const bps = typeof value === "number" ? value : Number(value);
      if (!Number.isInteger(bps) || bps < 0 || bps > COMMISSION_MAX_BPS) {
        // Misconfigured row — surface the problem rather than silently
        // applying a wrong rate.
        throw new BadRequestException({
          message: "Shopper commission is misconfigured.",
          code: "shopper_commission_misconfigured",
          value,
        });
      }
      return bps;
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      this.logger.error({ err }, "shopper.commission_load_failed");
      throw new InternalServerErrorException({
        message: "Could not load configuration.",
        code: "shopper_config_unavailable",
      });
    }
  }

  /**
   * Pull the state-keyed sales-tax rate map from the configuration table.
   * Returns a frozen object so callers can't mutate it. Falls back to
   * `{ TX: FALLBACK_TAX_BPS }` if the row is missing — reasonable for a
   * fresh dev environment that hasn't run migration 0014 yet.
   *
   * The rate map is intentionally PESSIMISTIC for unknown states (returns
   * 0 if a state isn't in the map) so we never overcharge — if we miss a
   * state, the buyer pays only items + commission at intake and the
   * actual tax surfaces in the followup invoice. Better than the inverse
   * (charging tax we don't know how to compute) which would produce
   * unjustified refunds.
   */
  private async loadTaxRates(): Promise<Record<string, number>> {
    try {
      const row = await this.prisma.configuration.findUnique({
        where: { key: TAX_RATES_CONFIG_KEY },
      });
      if (!row) return { [FALLBACK_WAREHOUSE_STATE]: FALLBACK_TAX_BPS };
      const value = row.value as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new BadRequestException({
          message: "Shopper tax rates are misconfigured (expected an object).",
          code: "shopper_tax_rates_misconfigured",
        });
      }
      // Validate each entry: key must look like a US state code, value
      // must be an integer 0–10000 bps. Skip invalid entries with a
      // warning rather than failing the whole request.
      const out: Record<string, number> = {};
      for (const [k, v] of Object.entries(value)) {
        if (!/^[A-Z]{2}$/.test(k)) continue;
        const bps = typeof v === "number" ? v : Number(v);
        if (Number.isInteger(bps) && bps >= 0 && bps <= COMMISSION_MAX_BPS) {
          out[k] = bps;
        } else {
          this.logger.warn({ state: k, value: v }, "shopper_tax_rates: skipping invalid entry");
        }
      }
      return out;
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      this.logger.error({ err }, "shopper.tax_rates_load_failed");
      throw new InternalServerErrorException({
        message: "Could not load configuration.",
        code: "shopper_config_unavailable",
      });
    }
  }

  /**
   * Resolve the warehouse state we ship to by default. Single-warehouse
   * setup today; this is the lookup point we'd extend if/when we run
   * multiple US warehouses. Falls back to TX if the row is missing.
   */
  private async loadWarehouseState(): Promise<string> {
    try {
      const row = await this.prisma.configuration.findUnique({
        where: { key: WAREHOUSE_STATE_CONFIG_KEY },
      });
      if (!row) return FALLBACK_WAREHOUSE_STATE;
      const value = row.value as unknown;
      const state =
        typeof value === "string" ? value.toUpperCase() : String(value ?? "").toUpperCase();
      if (!/^[A-Z]{2}$/.test(state)) {
        throw new BadRequestException({
          message: "Shopper warehouse state is misconfigured (expected 2-letter ISO).",
          code: "shopper_warehouse_state_misconfigured",
          value,
        });
      }
      return state;
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      this.logger.error({ err }, "shopper.warehouse_state_load_failed");
      throw new InternalServerErrorException({
        message: "Could not load configuration.",
        code: "shopper_config_unavailable",
      });
    }
  }

  /**
   * Load the wire-track threshold from configuration. Caps the value so
   * a misconfigured row can't accidentally disable the wire flow
   * entirely or push it down to a few dollars.
   */
  private async loadWireThresholdCents(): Promise<number> {
    try {
      const row = await this.prisma.configuration.findUnique({
        where: { key: WIRE_THRESHOLD_CONFIG_KEY },
      });
      if (!row) return WIRE_THRESHOLD_FALLBACK_CENTS;
      const value = row.value as unknown;
      const cents = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(cents) || cents < 0 || cents > WIRE_THRESHOLD_MAX_CENTS) {
        this.logger.warn(
          { value, max: WIRE_THRESHOLD_MAX_CENTS },
          "shopper_wire_threshold_cents: invalid; falling back to default",
        );
        return WIRE_THRESHOLD_FALLBACK_CENTS;
      }
      return Math.floor(cents);
    } catch (err) {
      this.logger.error({ err }, "shopper.wire_threshold_load_failed");
      return WIRE_THRESHOLD_FALLBACK_CENTS;
    }
  }

  /**
   * Load bank-transfer instructions from configuration. Returns null if
   * the row is missing OR if every meaningful field is empty (defence
   * against a half-configured environment leaking sensitive blanks).
   *
   * Only ever exposed to the buyer thread response when ID is APPROVED
   * AND status is one of the wire-payment states. The caller enforces
   * that contract — this loader is permissive.
   */
  private async loadBankInstructions(): Promise<Record<string, string> | null> {
    try {
      const row = await this.prisma.configuration.findUnique({
        where: { key: BANK_INSTRUCTIONS_CONFIG_KEY },
      });
      if (!row) return null;
      const value = row.value as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        this.logger.warn({ value }, "shopper_bank_instructions: not an object");
        return null;
      }
      const obj: Record<string, string> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (typeof v === "string") obj[k] = v;
      }
      // Are ANY meaningful (non-memo) fields populated? If the row is
      // still at its seeded blanks we treat it as absent.
      const meaningful = ["beneficiaryName", "bankName", "accountNumber", "routingNumber", "iban", "swift"];
      const hasAny = meaningful.some((k) => (obj[k] ?? "").trim().length > 0);
      return hasAny ? obj : null;
    } catch (err) {
      this.logger.error({ err }, "shopper.bank_instructions_load_failed");
      return null;
    }
  }

  /**
   * Validates that a URL we received from the buyer points at our R2
   * bucket. We accept either the configured public bucket URL or any
   * URL on the *.r2.cloudflarestorage.com hosts (private + public).
   * Throws if the URL is off-platform.
   */
  private assertUrlBelongsToOurBucket(url: string): void {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new BadRequestException({
        message: "Upload URL is malformed.",
        code: "shopper_upload_url_invalid",
      });
    }
    const host = parsed.host.toLowerCase();
    const publicBase = this.r2.getPublicBaseHost();
    const okPublic = publicBase ? host === publicBase : false;
    const okPrivate = /(^|\.)r2\.cloudflarestorage\.com$/.test(host);
    if (!okPublic && !okPrivate) {
      throw new BadRequestException({
        message: "Upload URL is not from our storage bucket.",
        code: "shopper_upload_url_off_platform",
      });
    }
  }

  /** Tiny HTML escape for ops-alert templates we build inline. */
  private escapeHtml(s: string): string {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /**
   * Buyer-facing serialization. Strips internal fields (admin notes,
   * Stripe ids, internal fee breakdown) — the buyer sees totals, status,
   * shipping, and lines without admin commentary.
   */
  private serializeBuyerRequest(row: Awaited<ReturnType<ShopperRequestService["getById"]>>) {
    return {
      id: row.id,
      reference: row.reference,
      parentRequestId: row.parentRequestId,
      status: row.status,
      buyerEmail: row.buyerEmail,
      buyerName: row.buyerName,
      // Migration 0023 — wire-track UI state. The buyer thread needs to
      // know which rail this is + how far through the ID/wire flow they
      // are; the bank-instructions payload is emitted SEPARATELY in
      // getThread() so we can gate it on idVerificationStatus + status.
      buyerPhone: row.buyerPhone,
      paymentMethod: row.paymentMethod,
      idVerificationStatus: row.idVerificationStatus,
      idRejectionReason: row.idRejectionReason,
      // We expose booleans, not URLs — the buyer doesn't need a direct
      // link to the file they themselves uploaded, and we don't want to
      // leak the path. Their own ID viewer renders nothing; only admin
      // sees the URLs.
      hasIdDocument: !!row.idDocumentUrl,
      hasIdSelfie: !!row.idSelfieUrl,
      hasWireProof: !!row.wireProofUrl,
      wireProofUploadedAt: row.wireProofUploadedAt,
      wireConfirmedAt: row.wireConfirmedAt,
      shippingAddress: row.shippingAddress,
      shippingMethod: row.shippingMethod,
      trackingNumber: row.trackingNumber,
      carrier: row.carrier,
      shippedAt: row.shippedAt,
      deliveredAt: row.deliveredAt,
      itemsSubtotalCents: row.itemsSubtotalCents,
      commissionCents: row.commissionCents,
      estimatedTaxRateBps: row.estimatedTaxRateBps,
      estimatedTaxCents: row.estimatedTaxCents,
      actualTaxCents: row.actualTaxCents,
      effectiveTaxState: row.effectiveTaxState,
      intakeTotalCents: row.intakeTotalCents,
      intakePaidAt: row.intakePaidAt,
      itemsActualSubtotalCents: row.itemsActualSubtotalCents,
      shippingCostCents: row.shippingCostCents,
      followupAmountCents: row.followupAmountCents,
      followupResolvedAt: row.followupResolvedAt,
      // Migration 0016 — parcel info shown to buyer alongside shipping cost.
      parcelLengthIn: row.parcelLengthIn,
      parcelWidthIn: row.parcelWidthIn,
      parcelHeightIn: row.parcelHeightIn,
      parcelWeightOz: row.parcelWeightOz,
      // Migration 0017 — freight rate snapshot + system-calculated cost.
      // Both nullable until admin saves shipping for the first time.
      freightRateCentsPerLb: row.freightRateCentsPerLb,
      shippingCalculatedCents: row.shippingCalculatedCents,
      createdAt: row.createdAt,
      lines: row.lines.map((line) => ({
        id: line.id,
        productUrl: line.productUrl,
        productTitle: line.productTitle,
        productNotes: line.productNotes,
        quantity: line.quantity,
        estimatedUnitPriceCents: line.estimatedUnitPriceCents,
        actualUnitPriceCents: line.actualUnitPriceCents,
        actualWeightOz: line.actualWeightOz,
        procurementStatus: line.procurementStatus,
      })),
    };
  }
}

