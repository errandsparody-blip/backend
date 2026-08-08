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
import { z } from "zod";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { TenantGuard } from "../../common/guards/tenant.guard";
import type { AuthenticatedUser } from "../../common/guards/jwt-auth.guard";
import { IdempotencyService } from "../../common/idempotency.service";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import {
  cancelOrderSchema,
  createOrderSchema,
  fulfillmentEstimateSchema,
  listOrdersSchema,
  parseAddressSchema,
  presignOrderLabelUploadSchema,
  quoteOrderSchema,
  validateAddressSchema,
  type CancelOrderInput,
  type CreateOrderInput,
  type FulfillmentEstimateInput,
  type ParseAddressInput,
  type ListOrdersInput,
  type PresignOrderLabelUploadInput,
  type QuoteOrderInput,
  type ValidateAddressInput,
} from "../../common/schemas/order.schema";

import { R2Service } from "../integrations/r2/r2.service";
import { ReturnService } from "../returns/return.service";

// Migration 0046 — vendor CSV bulk-import service. Delegated to; the
// controller only validates the upload envelope and defers to the
// service for parsing + per-row order creation.
import {
  IMPORT_MAX_BYTES,
  OrderImportService,
} from "./order-import.service";
import { OrderService } from "./order.service";

@Controller({ path: "orders", version: "1" })
@Roles(Role.VENDOR, Role.VENDOR_SUB_USER)
@UseGuards(TenantGuard)
export class OrderController {
  constructor(
    private readonly orders: OrderService,
    private readonly idempotency: IdempotencyService,
    private readonly returns: ReturnService,
    // R2Service is global (R2Module is @Global) so we don't need to
    // import a module here; we just inject the service to presign
    // vendor-supplied label uploads on the new VENDOR_CARRIER flow.
    private readonly r2: R2Service,
    // Migration 0046 — CSV bulk-import.
    private readonly imports: OrderImportService,
  ) {}

  // ---------------------------------------------------------------------------
  // Migration 0047 — the /fulfillment-config endpoint was removed. v1
  // has been abolished per spec so there's no branch for the frontend
  // to select. Leave a no-op stub returning { v2Enabled: true } for a
  // release cycle so an older cached web client doesn't hard-fail on
  // its startup query; drop the stub next release.
  // ---------------------------------------------------------------------------
  @Get("fulfillment-config")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  fulfillmentConfig(): { v2Enabled: boolean } {
    return { v2Enabled: true };
  }

  // ---------------------------------------------------------------------------
  // Migration 0041 — vendor-facing shipping estimate preview for the
  // v2 wizard. The wizard calls this on the Review step (v2 only) so
  // the vendor sees the exact estimate range + wallet-cover
  // requirement before clicking Submit. Backend uses the same points
  // math at submit — no drift possible.
  //
  // Same shape as /orders/fulfillment-estimate (which returns fee-only
  // info) but keyed to the shipping-points path. Kept separate so a
  // change to one doesn't accidentally alter the other.
  // ---------------------------------------------------------------------------
  @Post("shipping-estimate")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  shippingEstimate(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(fulfillmentEstimateSchema))
    body: FulfillmentEstimateInput,
  ) {
    // Reuse the same body schema as /fulfillment-estimate — both take
    // {lines, insuranceRequested?}. shippingEstimate ignores
    // insuranceRequested (v2 has no submit-time insurance).
    return this.orders.shippingEstimate(user.vendorId!, { lines: body.lines });
  }

  // ---------------------------------------------------------------------------
  // Validate address — pre-flight check before the vendor pays. Lets the
  // order-new form catch USPS rejections inline instead of failing at the
  // ship step after the wallet has been debited. No DB write.
  //
  // Rate-limited tighter than quote because the form will fire this on every
  // address-field blur (debounced client-side).
  // ---------------------------------------------------------------------------
  @Post("validate-address")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  validateAddress(
    @Body(new ZodValidationPipe(validateAddressSchema)) body: ValidateAddressInput,
  ) {
    return this.orders.validateAddress(body);
  }

  // ---------------------------------------------------------------------------
  // Parse a single pasted address string into structured fields (Shippo's
  // address parser). Powers the "paste a full address" convenience on the
  // order form. Throttled like validate-address — the form fires it on demand.
  // ---------------------------------------------------------------------------
  @Post("parse-address")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  parseAddress(@Body(new ZodValidationPipe(parseAddressSchema)) body: ParseAddressInput) {
    return this.orders.parseAddress(body.address);
  }

  // ---------------------------------------------------------------------------
  // Migration 0037 — Presign a PUT for a vendor-supplied shipping label
  // on the VENDOR_CARRIER fulfillment flow.
  //
  // The order/new wizard's Fulfillment step uses this so the vendor can
  // drag a PDF / image straight to R2 without first having to host it
  // on Drive / Dropbox / S3 and paste a URL.
  //
  // Scoping:
  //   - JWT + TenantGuard already gate the controller, so only the
  //     authenticated vendor can hit this. We further scope the R2 key
  //     under the vendorId so a forensic audit by vendor surfaces every
  //     uploaded label.
  //   - MIME allow-list is enforced by Zod (PDF + images only). No
  //     HTML/SVG accepted — those carry XSS risk on the same origin
  //     as our buyer-facing tracking pages.
  //   - Throttle is generous enough for normal usage (uploader can fire
  //     a couple of presigns for retries) but hostile to scripts.
  // ---------------------------------------------------------------------------
  @Post("uploads")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  presignLabelUpload(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(presignOrderLabelUploadSchema))
    body: PresignOrderLabelUploadInput,
  ) {
    // user.vendorId is guaranteed non-null inside this controller —
    // TenantGuard rejects requests without a vendor scope before they
    // ever reach a handler.
    const key = this.r2.generateKey(
      `orders/${user.vendorId}/labels`,
      body.filename,
    );
    return this.r2.presignPut({
      key,
      contentType: body.contentType,
      contentLengthBytes: body.contentLengthBytes,
    });
  }

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
  // Migration 0037 — fulfillment-cost estimate for the VENDOR_CARRIER
  // branch of the order wizard. Returns handling + insurance + total
  // without hitting Shippo, so the vendor sees a live running cost as
  // they add lines / toggle insurance.
  //
  // Cheaper than /quote (no carrier round-trip), so the rate limit is
  // higher — the wizard refetches whenever lines or insurance changes.
  // Still read-only; no idempotency key required.
  // ---------------------------------------------------------------------------
  @Post("fulfillment-estimate")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  fulfillmentEstimate(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(fulfillmentEstimateSchema))
    body: FulfillmentEstimateInput,
  ) {
    return this.orders.fulfillmentEstimate(user.vendorId!, body);
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
    // Returns v2 — there is NO platform-enforced return window (the age
    // limit is the vendor's own policy). `returnableUntil` is retained on
    // the response shape as always-null for backward compatibility; the
    // frontend no longer shows a window-expired state.
    return { ...order, returnableUntil: null as string | null };
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

  // ---------------------------------------------------------------------------
  // Migration 0046 — Vendor CSV bulk import.
  //
  // The CSV is uploaded as a JSON payload `{ csv, sourceFilename }`
  // so we don't need multipart parsing plumbing. The controller
  // enforces the outer size limit; the service enforces per-row and
  // per-cell limits.
  //
  // Rate limited (default = 60/min) to keep a runaway integration
  // script from tying up the request pipeline; the service is
  // synchronous per row.
  // ---------------------------------------------------------------------------
  @Post("import")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  importCsv(
    @CurrentUser() user: AuthenticatedUser,
    @Body(
      new ZodValidationPipe(
        z.object({
          csv: z.string().max(IMPORT_MAX_BYTES, {
            message: `csv exceeds ${IMPORT_MAX_BYTES} bytes.`,
          }),
          sourceFilename: z.string().trim().min(1).max(200),
        }),
      ),
    )
    body: { csv: string; sourceFilename: string },
  ) {
    return this.imports.importCsv(user.vendorId!, user.sub, {
      csv: body.csv,
      sourceFilename: body.sourceFilename,
    });
  }

  @Get("imports")
  listImports(@CurrentUser() user: AuthenticatedUser) {
    return this.imports
      .listForVendor(user.vendorId!, 50)
      .then((items) => ({ items }));
  }

  @Get("imports/:id")
  getImport(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", new ParseUUIDPipe()) id: string,
  ) {
    return this.imports.getForVendor(user.vendorId!, id);
  }
}
