/**
 * Admin SKU endpoints — cross-vendor inventory list, detail, movements,
 * and the manual ADJUST write.
 *
 *   GET    /v1/admin/skus
 *   GET    /v1/admin/skus/:id
 *   GET    /v1/admin/skus/:id/movements
 *   POST   /v1/admin/skus/:id/adjust
 *
 * The vendor-scoped `SkuController` lives at /v1/skus and is unrelated.
 * Both reach the same database, but with different access shapes.
 */

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { Role } from "@prisma/client";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../../common/guards/jwt-auth.guard";
import { IdempotencyService } from "../../common/idempotency.service";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import {
  adminAdjustSkuSchema,
  adminListMovementsSchema,
  adminListSkusSchema,
  type AdminAdjustSkuInput,
  type AdminListMovementsInput,
  type AdminListSkusInput,
} from "../../common/schemas/sku.schema";

import { AdminSkuService } from "./admin-sku.service";

const SKU_ID_RE = /^[A-Z0-9-]{6,80}$/;

@Controller({ path: "admin/skus", version: "1" })
@Roles(Role.WAREHOUSE_OPERATOR, Role.FINANCE_ADMIN, Role.SUPER_ADMIN)
export class AdminSkuController {
  constructor(
    private readonly skus: AdminSkuService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  list(@Query(new ZodValidationPipe(adminListSkusSchema)) q: AdminListSkusInput) {
    return this.skus.list(q);
  }

  @Get(":id")
  async get(@Param("id") id: string) {
    if (!SKU_ID_RE.test(id)) {
      throw new BadRequestException({ message: "Invalid SKU id", code: "sku_invalid_id" });
    }
    return this.skus.get(id);
  }

  @Get(":id/movements")
  async movements(
    @Param("id") id: string,
    @Query(new ZodValidationPipe(adminListMovementsSchema)) q: AdminListMovementsInput,
  ) {
    if (!SKU_ID_RE.test(id)) {
      throw new BadRequestException({ message: "Invalid SKU id", code: "sku_invalid_id" });
    }
    return this.skus.listMovements(id, q);
  }

  @Post(":id/adjust")
  async adjust(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body(new ZodValidationPipe(adminAdjustSkuSchema)) body: AdminAdjustSkuInput,
  ) {
    if (!SKU_ID_RE.test(id)) {
      throw new BadRequestException({ message: "Invalid SKU id", code: "sku_invalid_id" });
    }
    if (!idempotencyKey || idempotencyKey.length < 8) {
      throw new BadRequestException({
        message: "Idempotency-Key header is required for SKU adjustments.",
        code: "idempotency_key_required",
      });
    }

    // Resolve the SKU's vendor up-front so the idempotency key can be
    // scoped to that vendor (matches the pattern used by every other
    // money-/inventory-touching endpoint).
    const target = await this.skus.get(id);

    const endpoint = "POST /admin/skus/:id/adjust";
    const cached = await this.idempotency.lookup({
      key: idempotencyKey,
      endpoint,
      vendorId: target.vendorId,
      body,
    });
    if (cached) return cached.body;

    const result = await this.skus.adjust(id, user.sub, body);

    await this.idempotency.commit({
      key: idempotencyKey,
      endpoint,
      vendorId: target.vendorId,
      body,
      responseStatus: 200,
      responseBody: result as unknown as object,
    });

    return result;
  }
}
