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
  sendShopperPaymentInstructionsSchema,
  submitShopperIdUploadsSchema,
  submitShopperWireProofSchema,
  type CreateShopperRequestInput,
  type PostShopperMessageInput,
  type PresignShopperUploadInput,
  type SendShopperPaymentInstructionsInput,
  type SubmitShopperIdUploadsInput,
  type SubmitShopperWireProofInput,
} from "../../common/schemas/shopper.schema";
import { EmailService } from "../email/email.service";
import {
  opsBuyerMessageTemplate,
  opsNewShopperRequestTemplate,
  shopperIntakeReceivedTemplate,
  shopperPaymentInstructionsTemplate,
} from "../email/email-templates";
import { OpsAlertService } from "../notifications/ops-alert.service";
import { R2Service } from "../integrations/r2/r2.service";
import { StripeService } from "../integrations/stripe/stripe.service";

import {
  buyerIdCheckPassed,
  buyerIdVerificationRequired,
  loadWireThresholdCents,
} from "./shopper-id-verification.util";
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
  // GET /v1/shopper/config/public — buyer-facing config knobs.
  //
  // Surfaces the (live) ID-verification threshold so the public
  // intake page can render an accurate "above $X, ID required" hint
  // without hardcoding a dollar amount that drifts whenever finance
  // edits the admin config row. We expose ONLY the threshold for now
  // — every other config row stays admin-only. If a future addition
  // needs to be public, add it to the response shape here.
  //
  // Public route: no JWT, no token. Throttled enough to stay polite
  // but generous (the intake page fetches once on mount).
  // ---------------------------------------------------------------------------

  @Public()
  @Get("config/public")
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async getPublicConfig(): Promise<{ idVerificationThresholdCents: number }> {
    return {
      idVerificationThresholdCents: await loadWireThresholdCents(this.prisma, this.logger),
    };
  }

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
    const wireThresholdCents = await loadWireThresholdCents(this.prisma, this.logger);

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
    // May 2026 — All-manual payment policy. Payment rail is always WIRE
    // (the manual rail; STRIPE branch is no longer reachable). The
    // threshold check is repurposed: it decides whether the buyer must
    // pass ID verification BEFORE being shown payment instructions.
    //   itemsSubtotal >= threshold → ID required; status starts at
    //                                AWAITING_ID_VERIFICATION
    //   itemsSubtotal <  threshold → no ID; status starts at
    //                                AWAITING_WIRE_PAYMENT (the buyer
    //                                sees the multi-method picker
    //                                immediately).
    const requiresIdVerification = itemsSubtotalForRailCents >= wireThresholdCents;
    // Annotated explicitly via `as` so the `paymentMethod === "STRIPE"`
    // branch below still type-checks against the wider union, even
    // though we only ever assign "WIRE" today.
    const paymentMethod = "WIRE" as "STRIPE" | "WIRE";

    // 1. Persist request. Status + idVerificationStatus are set inside
    //    requests.create() based on (paymentMethod, requiresIdVerification):
    //      STRIPE                            → AWAITING_INTAKE_PAYMENT
    //      WIRE + requiresId                 → AWAITING_ID_VERIFICATION
    //      WIRE + !requiresId                → AWAITING_WIRE_PAYMENT
    const created = await this.requests.create(body, {
      commissionBps,
      estimatedTaxBps,
      effectiveTaxState,
      paymentMethod,
      requiresIdVerification,
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
          taxState: created.effectiveTaxState,
          taxRateBps: created.estimatedTaxRateBps,
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
      // Neutral "open your order page" copy — the thread itself walks the
      // buyer through any required ID verification and the payment-method
      // picker (wire / ACH / Zelle / Cash App / card), so the email no longer
      // hard-codes a wire-only, two-step framing.
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

    // Bank / payment instructions are only attached to the thread
    // response when the request is in a payment-pending state. May 2026
    // — ID required only when items subtotal (actual when quoted, else
    // estimate) is at/above the admin-configured threshold. Defensive
    // gating on top of the client-side check.
    const bankRevealStatuses = new Set([
      "QUOTE_SENT",
      "AWAITING_WIRE_PAYMENT",
      "WIRE_PROOF_UPLOADED",
      "WIRE_UNDER_REVIEW",
    ]);
    const idVerificationThresholdCents = await loadWireThresholdCents(
      this.prisma,
      this.logger,
    );
    const idCheckPassed = buyerIdCheckPassed(request, idVerificationThresholdCents);
    const shouldRevealBank =
      request.paymentMethod === "WIRE" &&
      idCheckPassed &&
      bankRevealStatuses.has(request.status as string);

    // Migration 0026 — prefer the per-request bank instructions chosen
    // by the admin at approval time. If null we fall back to the global
    // config row so historical requests created before this column was
    // populated keep working unchanged.
    let bankInstructions: Record<string, string> | null = null;
    if (shouldRevealBank) {
      const perRequest = (request as unknown as {
        wireBankInstructions?: Record<string, unknown> | null;
      }).wireBankInstructions;
      if (perRequest && typeof perRequest === "object") {
        const normalised: Record<string, string> = {};
        for (const [k, v] of Object.entries(perRequest)) {
          if (typeof v === "string" && v.trim().length > 0) normalised[k] = v.trim();
        }
        // Require at least an account number to count as "set" —
        // mirrors the Zod constraint admin-side.
        if (normalised.accountNumber) {
          bankInstructions = normalised;
        }
      }
      if (!bankInstructions) {
        bankInstructions = await this.loadBankInstructions();
      }
    }

    // Migration 0027 follow-up — surface the warehouse "Ship From"
    // address so the buyer can generate a prepaid label on their own
    // carrier (BUYER_FREIGHT method). Pulled from env, never hardcoded
    // — when we add a second warehouse this becomes a row lookup. We
    // emit unconditionally because the data isn't sensitive (it's the
    // address that ends up printed on every outbound parcel anyway)
    // and the client decides when to display it.
    const cfg = loadConfig();
    const warehouseShipFrom = {
      name: cfg.WAREHOUSE_FROM_NAME,
      line1: cfg.WAREHOUSE_FROM_STREET1,
      line2: cfg.WAREHOUSE_FROM_STREET2 ?? null,
      city: cfg.WAREHOUSE_FROM_CITY,
      state: cfg.WAREHOUSE_FROM_STATE,
      postalCode: cfg.WAREHOUSE_FROM_ZIP,
      country: "US" as const,
      phone: cfg.WAREHOUSE_FROM_PHONE,
      email: cfg.WAREHOUSE_FROM_EMAIL,
    };

    // May 2026 — Multi-method manual payments. Load the four
    // shopper_payment_method_<code> config rows and surface only the
    // ones marked active. Same gating as bankInstructions above so
    // an unverified buyer can't capture payment details by hitting
    // the endpoint with a random token before payment is due.
    //
    // Privacy posture (Jun 2026): we ONLY ship `{ code, label }` to
    // the browser — never the credential `details`. Details land in
    // the buyer's inbox after they pick a method and POST to
    // /payment/send-instructions. This keeps account numbers /
    // Zelle handles / Cash App tags out of the rendered DOM where
    // any browser extension, screen-recording tool, or shoulder-
    // surfer could lift them.
    const paymentMethodsFull = shouldRevealBank
      ? await this.loadActivePaymentMethods()
      : [];
    const paymentMethods = paymentMethodsFull.map((m) => ({
      code: m.code,
      label: m.label,
    }));

    // Legacy block — same posture. We expose only the boolean
    // "instructions are available" (so the UI can decide whether to
    // render the picker) and strip the actual fields. Anything with
    // an account-number key is treated as set.
    const legacyAvailable =
      bankInstructions != null &&
      typeof bankInstructions.accountNumber === "string" &&
      bankInstructions.accountNumber.trim().length > 0;

    return {
      request: {
        ...this.serializeBuyerRequest(request),
        parentReference,
        // Boolean-only signal kept for back-compat with the previous
        // single-method UI. The buyer thread no longer renders any
        // bank details inline — they arrive by email.
        bankInstructionsAvailable: legacyAvailable,
        // Each entry is { code, label }. Empty array when payment
        // isn't due yet. Details are intentionally NOT included.
        paymentMethods,
        warehouseShipFrom,
        // Live threshold — drives the IdVerificationCard's copy.
        idVerificationThresholdCents,
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

  /**
   * Load the four `shopper_payment_method_<code>` configuration rows
   * and return the active ones in display order. Each row is JSON of
   * shape `{ active: boolean, details: { [key]: string } }`.
   *
   * Missing rows, parse errors, or inactive rows are silently
   * filtered out so the buyer never sees a half-configured method.
   * If every method is missing or inactive, the array is empty —
   * the frontend renders a fallback ("contact us to arrange
   * payment") so the buyer is never stranded.
   */
  private async loadActivePaymentMethods(): Promise<
    Array<{ code: string; label: string; details: Record<string, string> }>
  > {
    // Display order matches the admin config card order. Hardcoded
    // (not config-driven) so admins can't accidentally reorder into
    // a state where Cash App appears above a wire transfer.
    const specs: ReadonlyArray<{ code: string; label: string }> = [
      { code: "wire", label: "Wire transfer" },
      { code: "ach", label: "ACH transfer" },
      { code: "zelle", label: "Zelle" },
      { code: "cashapp", label: "Cash App" },
    ];

    const rows = await Promise.all(
      specs.map(async (spec) => {
        try {
          const row = await this.prisma.configuration.findUnique({
            where: { key: `shopper_payment_method_${spec.code}` },
          });
          if (!row) return null;
          const value = row.value as { active?: unknown; details?: unknown } | null;
          if (!value || typeof value !== "object") return null;
          if (value.active !== true) return null;
          if (!value.details || typeof value.details !== "object") return null;

          // Normalise details — strip non-string values and empty
          // strings so the buyer UI only ever sees clean key/value
          // pairs. Object.entries is safe here because we just
          // checked typeof === "object".
          const cleanDetails: Record<string, string> = {};
          for (const [k, v] of Object.entries(value.details as Record<string, unknown>)) {
            if (typeof v === "string" && v.trim().length > 0) {
              cleanDetails[k] = v.trim();
            }
          }
          // Refuse to surface a method with zero details — an
          // "active but empty" config row is almost certainly a
          // mistake; better to hide it than show a buyer a blank
          // card with no way to pay.
          if (Object.keys(cleanDetails).length === 0) return null;

          return { code: spec.code, label: spec.label, details: cleanDetails };
        } catch (err) {
          this.logger.warn(
            { err, code: spec.code },
            "shopper.payment_methods.load_failed",
          );
          return null;
        }
      }),
    );

    const manual = rows.filter(
      (r): r is { code: string; label: string; details: Record<string, string> } =>
        r !== null,
    );

    // Card (Stripe) — always offered LAST. It's a built-in rail with no
    // credential details (the buyer pays on a hosted Checkout page, not by
    // copying account numbers), so it bypasses the details requirement above.
    // Gated on (a) an admin-toggled config row AND (b) Stripe actually being
    // configured, so the option never appears when it can't complete.
    if (this.stripe.isConfigured()) {
      try {
        const row = await this.prisma.configuration.findUnique({
          where: { key: "shopper_payment_method_stripe" },
        });
        const value = row?.value as { active?: unknown; label?: unknown } | null;
        if (value && typeof value === "object" && value.active === true) {
          const label =
            typeof value.label === "string" && value.label.trim().length > 0
              ? value.label.trim()
              : "Debit / credit card";
          manual.push({ code: "stripe", label, details: {} });
        }
      } catch (err) {
        this.logger.warn({ err }, "shopper.payment_methods.stripe_load_failed");
      }
    }

    return manual;
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
    const thresholdCents = await loadWireThresholdCents(this.prisma, this.logger);
    if (!buyerIdVerificationRequired(request, thresholdCents)) {
      throw new BadRequestException({
        message: "This order is below the ID verification threshold.",
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
    // if (request.idVerificationStatus !== "APPROVED") {
    //   throw new BadRequestException({
    //     message: "ID must be approved before uploading wire proof.",
    //     code: "shopper_wire_id_not_verified",
    //   });
    // }
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
  // POST /v1/shopper/r/:token/payment/send-instructions
  //
  // Buyer picked a payment method on the thread page and asked us to
  // email them the account details. The browser never receives the
  // credentials — they go straight to the buyer's inbox. This makes
  // it materially harder for a screen-recording extension, a
  // shoulder-surfer, or a malicious browser to lift the account
  // numbers / Zelle handle / Cash App tag.
  //
  // Validations (all server-side, in order):
  //   1. Token resolves to a real request (magic-link auth).
  //   2. paymentMethod === "WIRE" (the only rail today; STRIPE
  //      requests don't go through this flow).
  //   3. ID check passes — either NONE (below threshold) or APPROVED.
  //   4. Status is one of the payment-pending / under-review states
  //      where revealing credentials is appropriate.
  //   5. methodCode matches one of the active config rows.
  //   6. The method has at least one populated detail field.
  //
  // Idempotency: the EmailService dedupes by key. We bucket the key
  // by a coarse 60-second window so rapid double-clicks send one
  // email, while a buyer coming back an hour later can request a
  // fresh send. Throttle on top caps abuse at 5/min/IP.
  // ---------------------------------------------------------------------------

  @Public()
  @Post("r/:token/payment/send-instructions")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async sendPaymentInstructions(
    @Param("token") token: string,
    @Body(new ZodValidationPipe(sendShopperPaymentInstructionsSchema))
    body: SendShopperPaymentInstructionsInput,
  ): Promise<{
    sentTo: string;
    methodLabel: string;
    methodCode: string;
    /** Present only for the card method — the hosted Stripe Checkout URL. */
    checkoutUrl?: string;
  }> {
    const resolved = await this.tokens.resolve(token);
    const request = await this.requests.getById(resolved.requestId, {
      includeLines: false,
    });

    // (2) Manual-payment rail only. STRIPE intake doesn't surface a
    // method picker, so anything else hitting this endpoint is either
    // confused or hostile — reject identically either way.
    if (request.paymentMethod !== "WIRE") {
      throw new BadRequestException({
        message: "This request isn't on the manual-payment track.",
        code: "shopper_payment_not_applicable",
      });
    }

    // (3) ID check. Mirrors the gating in getThread() so a buyer who
    // hasn't passed ID can't pivot from the picker to an endpoint and
    // skip the check.
    const thresholdCents = await loadWireThresholdCents(this.prisma, this.logger);
    if (!buyerIdCheckPassed(request, thresholdCents)) {
      throw new BadRequestException({
        message:
          "Identity verification must be completed before payment instructions can be released.",
        code: "shopper_payment_id_not_verified",
      });
    }

    // (4) Status gate — same set the thread response checks. We
    // include the under-review states so a buyer who already paid
    // but lost the original email can still pull a fresh copy.
    const allowed = new Set([
      "QUOTE_SENT",
      "AWAITING_WIRE_PAYMENT",
      "WIRE_PROOF_UPLOADED",
      "WIRE_UNDER_REVIEW",
    ]);
    if (!allowed.has(request.status as string)) {
      throw new BadRequestException({
        message:
          "Payment instructions can only be sent while the request is awaiting payment.",
        code: "shopper_payment_instructions_invalid_state",
        status: request.status,
      });
    }

    // (5) + (6) Method must be currently active AND have details.
    const activeMethods = await this.loadActivePaymentMethods();
    const chosen = activeMethods.find((m) => m.code === body.methodCode);
    if (!chosen) {
      // 404-ish — don't disclose what's configured to anyone with a
      // valid token but a wrong methodCode. Same surface as "not
      // active" so an attacker can't enumerate the list.
      throw new BadRequestException({
        message: "That payment method isn't available right now.",
        code: "shopper_payment_method_not_active",
      });
    }
    // Card (Stripe) rail — no emailed credentials. Create a hosted Checkout
    // session (buyer covers the processing fee via gross-up) and hand the URL
    // back for the client to redirect to. The webhook lands the request in
    // PROCURING once payment confirms.
    if (chosen.code === "stripe") {
      const cfg = loadConfig();
      const successUrl = `${cfg.WEB_PUBLIC_URL}/shopper/r/${encodeURIComponent(token)}?paid=1`;
      const cancelUrl = `${cfg.WEB_PUBLIC_URL}/shopper/r/${encodeURIComponent(token)}?cancelled=1`;
      // Bucket the idempotency key by minute: rapid double-clicks reuse one
      // session, while a buyer returning later gets a fresh one.
      const bucket = Math.floor(Date.now() / 60_000);
      let session: { sessionId: string; paymentIntentId: string | null; url: string };
      try {
        session = await this.stripe.createShopperCardIntakeSession({
          requestId: request.id,
          buyerEmail: request.buyerEmail,
          itemsSubtotalCents: request.itemsSubtotalCents,
          commissionCents: request.commissionCents,
          estimatedTaxCents: request.estimatedTaxCents,
          taxState: request.effectiveTaxState,
          taxRateBps: request.estimatedTaxRateBps,
          idempotencyKey: `shopper:card_intake:${request.id}:${bucket}`,
          successUrl,
          cancelUrl,
        });
      } catch (err) {
        this.logger.error(
          { requestId: request.id, err: `${err}` },
          "shopper.card_intake.session_failed",
        );
        throw new InternalServerErrorException({
          message: "We couldn't start the card checkout. Please try again in a moment.",
          code: "shopper_card_checkout_failed",
        });
      }
      // Persist the session/intent so refund + dispute webhooks can find it.
      await this.requests.attachIntakeSession(
        request.id,
        session.sessionId,
        session.paymentIntentId,
      );
      return {
        sentTo: request.buyerEmail,
        methodLabel: chosen.label,
        methodCode: chosen.code,
        checkoutUrl: session.url,
      };
    }

    if (Object.keys(chosen.details).length === 0) {
      throw new BadRequestException({
        message: "That payment method isn't available right now.",
        code: "shopper_payment_method_not_active",
      });
    }

    // Humanise the field keys for the email template. The buyer-facing
    // copy used to live in the thread component (humanLabel) — we
    // mirror it here so the email is self-contained and changing one
    // side doesn't drift the other. We preserve the order the admin
    // stored fields in (Object.entries respects insertion order for
    // string keys) so the email reads in the same order the admin
    // intended.
    const details = Object.entries(chosen.details).map(([key, value]) => ({
      label: this.humanLabel(key),
      value,
    }));

    const tpl = shopperPaymentInstructionsTemplate({
      reference: request.reference,
      threadToken: token,
      amountCents: request.intakeTotalCents,
      methodLabel: chosen.label,
      details,
    });

    // Idempotency bucket — clicking N times in a minute sends 1 email;
    // clicking again after a minute (or on a different method) sends
    // a fresh one. Math.floor / 60_000 gives a stable bucket id per
    // 60-second window. Combined with the @Throttle decorator above.
    const bucket = Math.floor(Date.now() / 60_000);
    const idempotencyKey = `shopper:payment_instructions:${request.id}:${chosen.code}:${bucket}`;

    // Await + check the result. EmailService returns { ok, error }
    // instead of throwing on provider failure, so a fire-and-forget
    // here would tell the buyer "check your email" while nothing
    // ever leaves Resend. We surface a 500 with a recognisable code
    // so the frontend's error banner renders meaningful copy and the
    // buyer can retry.
    const sendResult = await this.email.send({
      to: request.buyerEmail,
      subject: tpl.subject,
      html: tpl.html,
      text: tpl.text,
      idempotencyKey,
      type: "shopper.payment_instructions",
    });
    if (!sendResult.ok) {
      this.logger.error(
        { requestId: request.id, method: chosen.code, error: sendResult.error },
        "shopper.payment_instructions.email_failed",
      );
      throw new InternalServerErrorException({
        message:
          "We couldn't send the payment instructions email. Please try again in a moment.",
        code: "shopper_payment_instructions_email_failed",
      });
    }

    // Ops alert — operators want to see that a buyer asked for
    // credentials (correlates with the eventual wire-proof upload).
    // Best-effort; never block the buyer on this.
    void this.opsAlerts
      .send({
        type: "ops.shopper.payment_instructions_sent",
        subject: `[${request.reference}] Payment instructions sent — ${chosen.label}`,
        html: `<p>Buyer <strong>${this.escapeHtml(request.buyerEmail)}</strong> requested ${this.escapeHtml(chosen.label)} instructions for ${this.escapeHtml(request.reference)}.</p>`,
        text: `Buyer ${request.buyerEmail} requested ${chosen.label} instructions for ${request.reference}.`,
        // Use the same bucket here so a rapid-fire double-click does
        // not double-alert the ops team either.
        idempotencyKey: `ops:shopper:payment_instructions:${request.id}:${chosen.code}:${bucket}`,
        href: `/admin/shopper/${request.id}`,
      })
      .catch(() => undefined);

    // Echo back only what the buyer needs to display the confirmation
    // card — never the credentials themselves. methodCode is included
    // so the client can match the in-flight selection to the
    // confirmation by stable id (labels can change if an admin renames
    // a method while the buyer is on the page).
    return {
      sentTo: request.buyerEmail,
      methodLabel: chosen.label,
      methodCode: chosen.code,
    };
  }

  /**
   * Convert a camelCase config key into a human-readable label for
   * email rendering. Mirrors the frontend humanLabel() so changes to
   * the field naming don't surprise either side.
   */
  private humanLabel(key: string): string {
    const spaced = key.replace(/([a-z])([A-Z])/g, "$1 $2");
    return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
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

