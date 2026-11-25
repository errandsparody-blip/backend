/**
 * Public WooCommerce webhook receiver.
 *
 *   POST /v1/integration/woocommerce/:token
 *
 * The vendor pastes this URL (token included) into their WooCommerce store's
 * "Order created" webhook Delivery URL. Auth is the unguessable per-vendor
 * token in the path — no human session, so the route is @Public(). We answer
 * 200 for any recognised token (even when the order is held or unusable) so
 * WooCommerce never disables the webhook; only an unknown token gets 401.
 */

import { Body, Controller, HttpCode, HttpStatus, Param, Post, UnauthorizedException } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";

import { Public } from "../../common/decorators/public.decorator";

import { WooCommerceWebhookService } from "./woocommerce-webhook.service";

@Controller({ path: "integration/woocommerce", version: "1" })
@Public()
export class WooCommerceWebhookController {
  constructor(private readonly woo: WooCommerceWebhookService) {}

  @Post(":token")
  @HttpCode(HttpStatus.OK)
  // Generous limit: a busy store can burst several orders a minute, and each
  // delivery is cheap (resolve token → map → ingest).
  @Throttle({ default: { limit: 240, ttl: 60_000 } })
  async receive(@Param("token") token: string, @Body() body: unknown): Promise<{ status: string }> {
    const vendorId = await this.woo.vendorIdForToken(token);
    if (!vendorId) {
      // Unknown/rotated token — the only case where we bounce, so a stale URL
      // is obvious in WooCommerce's delivery log.
      throw new UnauthorizedException({
        message: "Unknown WooCommerce webhook token.",
        code: "woocommerce_token_invalid",
      });
    }
    const status = await this.woo.handle(vendorId, body);
    return { status };
  }
}
