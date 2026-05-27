/**
 * AdminProductController — override path for the warehouse when
 * vendor-declared product details (weight, dimensions, declared
 * value, customs code, country, storage tier) don't match what we
 * actually receive.
 *
 * Vendor edits to products are locked the moment the product is
 * created (see ProductService.update). Admin has a parallel
 * write-path through this controller so the receiving team can
 * correct the record without asking the vendor to recreate the
 * product. The receiving fee the vendor already paid covers this
 * work.
 *
 * Authorization: SUPER_ADMIN only. Throttled at 60 edits per minute
 * per actor — a runaway script can't silently rewrite half a vendor's
 * catalogue.
 *
 * Every edit writes an audit log entry (`product.admin_edited`) with
 * the actor id, before/after snapshots, and the optional free-text
 * reason. Finance can reconcile shipping disputes against the log.
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
} from "@nestjs/common";
import { Role } from "@prisma/client";
import { Throttle } from "@nestjs/throttler";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../../common/guards/jwt-auth.guard";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import {
  adminEditProductSchema,
  type AdminEditProductInput,
} from "../../common/schemas/product.schema";
import { ProductService } from "../products/product.service";

@Controller({ path: "admin/products", version: "1" })
export class AdminProductController {
  constructor(private readonly products: ProductService) {}

  @Roles(Role.FINANCE_ADMIN, Role.SUPER_ADMIN)
  @Get(":id")
  async detail(@Param("id", new ParseUUIDPipe()) id: string) {
    return this.products.getByIdAsAdmin(id);
  }

  @Roles(Role.SUPER_ADMIN)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Patch(":id")
  @HttpCode(HttpStatus.OK)
  async edit(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(adminEditProductSchema)) body: AdminEditProductInput,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.products.editAsAdmin(actor.sub, id, body);
  }
}
