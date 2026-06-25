/**
 * Storefront integration API — the PUBLIC contract a vendor's website calls.
 *
 * Auth is the integration API key (ApiKeyGuard), NOT a human JWT session, so
 * the controller is marked @Public() to opt out of the global JwtAuthGuard /
 * AgreementVersionGuard and lets ApiKeyGuard own authentication. ApiKeyGuard
 * populates request.user with the resolved vendor, so tenant scoping downstream
 * is identical to the portal.
 *
 *   POST /v1/integration/orders                    — ingest a paid store order
 *   GET  /v1/integration/orders/:externalReference — poll order/fulfillment status
 *
 * Idempotency: re-sending the same `externalReference` always returns the
 * existing order (DB-enforced unique). An optional `Idempotency-Key` header is
 * additionally honored for byte-identical replay of the HTTP response.
 */

import {
  Body,
  Controller,
  Get,
  Headers,
  HttpStatus,
  Param,
  Post,
  Res,
  UseGuards,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { Response } from "express";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Public } from "../../common/decorators/public.decorator";
import { ApiKeyGuard, type ApiKeyAuthenticatedUser } from "../../common/guards/api-key.guard";
import { IdempotencyService } from "../../common/idempotency.service";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import {
  integrationOrderSchema,
  type IntegrationOrderInput,
} from "../../common/schemas/integration.schema";

import { IntegrationOrderService } from "./integration-order.service";

@Controller({ path: "integration/orders", version: "1" })
@Public()
@UseGuards(ApiKeyGuard)
export class IntegrationController {
  constructor(
    private readonly orders: IntegrationOrderService,
    private readonly idempotency: IdempotencyService,
  ) {}

  // ---------------------------------------------------------------------------
  // Ingest a paid order from the vendor's store.
  //   201 Created  — allocated (stock reserved, wallet debited).
  //   202 Accepted — held (see `holdReason`); will fulfill once resolved.
  // ---------------------------------------------------------------------------
  @Post()
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  async ingest(
    @CurrentUser() user: ApiKeyAuthenticatedUser,
    @Body(new ZodValidationPipe(integrationOrderSchema)) body: IntegrationOrderInput,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const vendorId = user.vendorId!;

    const hasIdem = !!idempotencyKey && idempotencyKey.length >= 8 && idempotencyKey.length <= 255;
    if (hasIdem) {
      const cached = await this.idempotency.lookup({
        key: idempotencyKey!,
        endpoint: "POST /v1/integration/orders",
        vendorId,
        body,
      });
      if (cached) {
        res.status(cached.status);
        return cached.body;
      }
    }

    const result = await this.orders.ingest({ vendorId, apiKeyId: user.apiKeyId, input: body });
    const status = result.held ? HttpStatus.ACCEPTED : HttpStatus.CREATED;
    res.status(status);

    if (hasIdem) {
      await this.idempotency.commit({
        key: idempotencyKey!,
        endpoint: "POST /v1/integration/orders",
        vendorId,
        body,
        responseStatus: status,
        responseBody: result,
      });
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Poll status by the store's own order id.
  // ---------------------------------------------------------------------------
  @Get(":externalReference")
  @Throttle({ default: { limit: 240, ttl: 60_000 } })
  async status(
    @CurrentUser() user: ApiKeyAuthenticatedUser,
    @Param("externalReference") externalReference: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const found = await this.orders.getByExternalReference(user.vendorId!, externalReference);
    if (!found) {
      res.status(HttpStatus.NOT_FOUND);
      return { message: "No order found for that reference.", code: "order_not_found" };
    }
    return found;
  }
}
