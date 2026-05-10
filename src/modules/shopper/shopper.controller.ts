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
  type CreateShopperRequestInput,
  type PostShopperMessageInput,
  type PresignShopperUploadInput,
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
    payUrl: string;
    intakeTotalCents: number;
  }> {
    const cfg = loadConfig();
    const commissionBps = await this.loadCommissionBps();

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

    // 1. Persist request (status = AWAITING_INTAKE_PAYMENT).
    const created = await this.requests.create(body, {
      commissionBps,
      estimatedTaxBps,
      effectiveTaxState,
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

    // 4. Create the intake Checkout session.
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
      // Stripe outage during intake. The request is already saved with status
      // AWAITING_INTAKE_PAYMENT; the buyer can retry from the thread page.
      this.logger.error({ err, requestId: created.id }, "shopper.intake.stripe_failed");
      throw new InternalServerErrorException({
        message: "Could not start payment. Please try again.",
        code: "shopper_stripe_unavailable",
      });
    }

    await this.requests.attachIntakeSession(created.id, session.sessionId, session.paymentIntentId);

    // 5. Email the buyer the magic link + the Stripe Checkout URL.
    // Look up parent reference (if any) so the email can show "addition
    // to SHP-000041" instead of just a UUID. Best-effort — failure here
    // shouldn't block the intake email; we just omit the parent context.
    let parentReference: string | null = null;
    if (created.parentRequestId) {
      const parentRow = await this.requests
        .getById(created.parentRequestId, { includeLines: false })
        .catch(() => null);
      parentReference = parentRow?.reference ?? null;
    }

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

    // Ops alert — admin team needs to know a new request landed even
    // before the buyer pays. The intake-paid signal is separate.
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
      })
      .catch(() => undefined);

    return {
      requestId: created.id,
      reference: created.reference,
      threadUrl: `${cfg.WEB_PUBLIC_URL}/shopper/r/${encodeURIComponent(issued.plaintext)}`,
      payUrl: session.url,
      intakeTotalCents: created.intakeTotalCents,
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

    return {
      request: { ...this.serializeBuyerRequest(request), parentReference },
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

