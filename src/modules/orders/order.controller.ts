/**
 * Vendor-facing Order endpoints. Implementation Plan §6.6.
 *
 * Routes:
 *   POST   /v1/orders/quote   — get rates + fee preview, no DB write
 *   POST   /v1/orders         — atomic submit (Idempotency-Key required)
 *   GET    /v1/orders         — list (cursor pagination)
 *   GET    /v1/orders/:id     — vendor-scoped detail
 *   POST   /v1/orders/:id/cancel
 *
 * All routes are gated by VENDOR / VENDOR_SUB_USER role + TenantGuard.
 */

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { Role } from "@prisma/client";
import type { Response } from "express";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { TenantGuard } from "../../common/guards/tenant.guard";
import type { AuthenticatedUser } from "../../common/guards/jwt-auth.guard";
import { IdempotencyService } from "../../common/idempotency.service";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import {
  cancelOrderSchema,
  createOrderSchema,
  listOrdersSchema,
  quoteOrderSchema,
  type CancelOrderInput,
  type CreateOrderInput,
  type ListOrdersInput,
  type QuoteOrderInput,
} from "../../common/schemas/order.schema";

import { ReturnService } from "../returns/return.service";

import { OrderService } from "./order.service";

@Controller({ path: "orders", version: "1" })
@Roles(Role.VENDOR, Role.VENDOR_SUB_USER)
@UseGuards(TenantGuard)
export class OrderController {
  constructor(
    private readonly orders: OrderService,
    private readonly idempotency: IdempotencyService,
    private readonly returns: ReturnService,
  ) {}

  // ---------------------------------------------------------------------------
  // Quote — no DB write, no idempotency required.
  // Rate-limited because it hits the carrier API on every call.
  // ---------------------------------------------------------------------------
  @Post("quote")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  quote(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(quoteOrderSchema)) body: QuoteOrderInput,
  ) {
    return this.orders.quote(user.vendorId!, body);
  }

  // ---------------------------------------------------------------------------
  // Create — Idempotency-Key REQUIRED. Replays return the cached response.
  // ---------------------------------------------------------------------------
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(createOrderSchema)) body: CreateOrderInput,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 255) {
      throw new BadRequestException({
        message: "Idempotency-Key header is required for order creation (8–255 chars).",
        code: "idempotency_key_required",
      });
    }

    const cached = await this.idempotency.lookup({
      key: idempotencyKey,
      endpoint: "POST /v1/orders",
      vendorId: user.vendorId!,
      body,
    });
    if (cached) {
      res.status(cached.status);
      return cached.body;
    }

    const created = await this.orders.create(user.vendorId!, user.sub, body);

    await this.idempotency.commit({
      key: idempotencyKey,
      endpoint: "POST /v1/orders",
      vendorId: user.vendorId!,
      body,
      responseStatus: HttpStatus.CREATED,
      responseBody: created,
    });

    return created;
  }

  // ---------------------------------------------------------------------------
  // Reads — cursor-paginated list + single-order detail.
  // ---------------------------------------------------------------------------
  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query(new ZodValidationPipe(listOrdersSchema)) q: ListOrdersInput,
  ) {
    return this.orders.list(user.vendorId!, q);
  }

  @Get(":id")
  async get(@CurrentUser() user: AuthenticatedUser, @Param("id", new ParseUUIDPipe()) id: string) {
    const order = await this.orders.get(user.vendorId!, id);
    // Migration 0018 — surface the return-window cutoff so the
    // frontend can hide the "Request return" CTA when this order is
    // outside the window. Null when the order isn't delivered yet
    // (return CTA hidden for a different reason). The same
    // configurable window is enforced server-side at RMA creation;
    // exposing it on the order GET keeps frontend + backend honest.
    let returnableUntil: string | null = null;
    if (order.deliveredAt) {
      const windowDays = await this.returns.getReturnWindowDays();
      returnableUntil = new Date(
        order.deliveredAt.getTime() + windowDays * 24 * 60 * 60 * 1000,
      ).toISOString();
    }
    return { ...order, returnableUntil };
  }

  // ---------------------------------------------------------------------------
  // Cancel.
  // ---------------------------------------------------------------------------
  @Post(":id/cancel")
  @HttpCode(HttpStatus.OK)
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(cancelOrderSchema)) body: CancelOrderInput,
  ) {
    return this.orders.cancel(user.vendorId!, user.sub, id, body);
  }
}
