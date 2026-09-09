/**
 * Storefront payment webhooks (Migration 0059) — PUBLIC, protected by the
 * processor's signature. An order is marked paid ONLY here, never from a
 * browser callback. Handlers verify the signature (via the processor), then
 * hand the normalised event to the idempotent StorefrontOrderService.
 *
 *   POST /v1/storefront/webhooks/stripe     (header: stripe-signature)
 *   POST /v1/storefront/webhooks/paystack   (header: x-paystack-signature)
 */
import {
  BadRequestException,
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
import type { Request } from "express";

import { Public } from "../../common/decorators/public.decorator";

import { PaymentProcessorRegistry } from "../payments/payment-processor.registry";
import type { ProcessorKey } from "../payments/payment-processor.interface";
import { StorefrontOrderService } from "./storefront-order.service";

@Controller({ path: "storefront/webhooks", version: "1" })
export class StorefrontWebhookController {
  private readonly logger = new Logger(StorefrontWebhookController.name);

  constructor(
    private readonly registry: PaymentProcessorRegistry,
    private readonly orders: StorefrontOrderService,
  ) {}

  @Public()
  @Post("stripe")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  async stripe(
    @Headers("stripe-signature") signature: string | undefined,
    @Req() req: Request & { rawBody?: Buffer },
    @Body() body: unknown,
  ): Promise<{ ok: true }> {
    return this.handle("STRIPE", signature, req, body);
  }

  @Public()
  @Post("paystack")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  async paystack(
    @Headers("x-paystack-signature") signature: string | undefined,
    @Req() req: Request & { rawBody?: Buffer },
    @Body() body: unknown,
  ): Promise<{ ok: true }> {
    return this.handle("PAYSTACK", signature, req, body);
  }

  private async handle(
    key: ProcessorKey,
    signature: string | undefined,
    req: Request & { rawBody?: Buffer },
    body: unknown,
  ): Promise<{ ok: true }> {
    const raw = req.rawBody ?? Buffer.from(JSON.stringify(body ?? {}));
    let event;
    try {
      event = this.registry.get(key).verifyAndParseWebhook(raw, signature ?? "");
    } catch (err) {
      this.logger.warn({ err: `${err}`, key }, "storefront.webhook.bad_signature");
      // Non-2xx so the processor retries a genuine transient mismatch.
      throw new BadRequestException("Invalid webhook signature.");
    }

    try {
      await this.orders.markPaidFromEvent(event);
    } catch (err) {
      // Log + 200: the event was authentic. Re-driving is handled by our own
      // reconciliation, not by asking the processor to retry indefinitely.
      this.logger.error({ err: `${err}`, key }, "storefront.webhook.handle_failed");
    }
    return { ok: true };
  }
}
