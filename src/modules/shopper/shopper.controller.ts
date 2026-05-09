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
import { shopperIntakeReceivedTemplate } from "../email/email-templates";
import { R2Service } from "../integrations/r2/r2.service";
import { StripeService } from "../integrations/stripe/stripe.service";

import { ShopperMessageService } from "./shopper-message.service";
import { ShopperRequestService } from "./shopper-request.service";
import { ShopperTokenService } from "./shopper-token.service";

const COMMISSION_CONFIG_KEY = "shopper_commission_bps";
const COMMISSION_DEFAULT_BPS = 1800;
const COMMISSION_MAX_BPS = 10_000;

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
    threadUrl: string;
    payUrl: string;
    intakeTotalCents: number;
  }> {
    const cfg = loadConfig();
    const commissionBps = await this.loadCommissionBps();

    // 1. Persist request (status = AWAITING_INTAKE_PAYMENT).
    const created = await this.requests.create(body, commissionBps);

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
    const tpl = shopperIntakeReceivedTemplate({
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

    return {
      requestId: created.id,
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

    return {
      request: this.serializeBuyerRequest(request),
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

    // Notify the admin via in-app notifications (we don't email admins for
    // every buyer reply — they live on the queue page). The notification
    // hookup lands in the admin controller's notification settings; for now
    // we just log so the assigned admin sees it via the queue's unread badge.
    this.logger.log(
      { requestId: resolved.requestId, messageId: message.id },
      "shopper.buyer_message",
    );

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
   * Buyer-facing serialization. Strips internal fields (admin notes,
   * Stripe ids, internal fee breakdown) — the buyer sees totals, status,
   * shipping, and lines without admin commentary.
   */
  private serializeBuyerRequest(row: Awaited<ReturnType<ShopperRequestService["getById"]>>) {
    return {
      id: row.id,
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
      intakeTotalCents: row.intakeTotalCents,
      intakePaidAt: row.intakePaidAt,
      itemsActualSubtotalCents: row.itemsActualSubtotalCents,
      shippingCostCents: row.shippingCostCents,
      followupAmountCents: row.followupAmountCents,
      followupResolvedAt: row.followupResolvedAt,
      createdAt: row.createdAt,
      lines: row.lines.map((line) => ({
        id: line.id,
        productUrl: line.productUrl,
        productTitle: line.productTitle,
        productNotes: line.productNotes,
        quantity: line.quantity,
        estimatedUnitPriceCents: line.estimatedUnitPriceCents,
        actualUnitPriceCents: line.actualUnitPriceCents,
        procurementStatus: line.procurementStatus,
      })),
    };
  }
}

