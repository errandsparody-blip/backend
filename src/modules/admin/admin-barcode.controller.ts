/**
 * Admin barcode endpoints (Migration 0044).
 *
 * Routes:
 *   GET    /v1/admin/products/:productId/barcodes   — list product's barcodes
 *   POST   /v1/admin/products/:productId/barcodes   — register a barcode
 *   DELETE /v1/admin/product-barcodes/:id           — remove a barcode
 *   GET    /v1/admin/barcodes/lookup?code=…         — resolve a barcode → product
 *
 * RBAC:
 *   * Reads (list + lookup)  — any admin who can read products (pack
 *     scanner needs the lookup path).
 *   * Writes (register + remove) — SUPER_ADMIN only.
 *
 * Audit trail: every write is logged with before/after JSON.
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from "@nestjs/common";
import { Prisma, Role } from "@prisma/client";
import { z } from "zod";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../../common/guards/jwt-auth.guard";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { AuditService } from "../audit/audit.service";
import {
  BARCODE_SYMBOLOGIES,
  BarcodeService,
} from "../products/barcode.service";

const ROLE_ADMIN = "ADMIN" as Role;

const registerSchema = z.object({
  barcode: z.string().trim().min(1).max(48),
  symbology: z.enum(BARCODE_SYMBOLOGIES).optional(),
  isPrimary: z.boolean().optional(),
});
type RegisterInput = z.infer<typeof registerSchema>;

const lookupSchema = z.object({
  code: z.string().trim().min(1).max(48),
});
type LookupInput = z.infer<typeof lookupSchema>;

// Roles at the CLASS level: any admin can hit the reads; writes are
// re-restricted to SUPER_ADMIN at the method level.
@Controller({ path: "admin", version: "1" })
@Roles(Role.WAREHOUSE_OPERATOR, Role.FINANCE_ADMIN, Role.SUPER_ADMIN, ROLE_ADMIN)
export class AdminBarcodeController {
  constructor(
    private readonly barcodes: BarcodeService,
    private readonly audit: AuditService,
  ) {}

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  // No @RequiresPage — barcode reads are gated purely by role.
  // AdminProductController follows the same pattern (products don't
  // have their own page-permission key). Class-level @Roles ensures
  // only admin-tier users can hit these; @Roles(Role.SUPER_ADMIN) at
  // the method level re-restricts the writes.
  @Get("products/:productId/barcodes")
  async listForProduct(
    @Param("productId", new ParseUUIDPipe()) productId: string,
  ) {
    const items = await this.barcodes.listForProduct(productId);
    return { items };
  }

  @Get("barcodes/lookup")
  async lookup(@Query(new ZodValidationPipe(lookupSchema)) q: LookupInput) {
    const match = await this.barcodes.lookup(q.code);
    // Never 404 on lookup — the scanner UX expects a `match: null`
    // sentinel so it can render "unknown barcode" without a network error.
    return { match };
  }

  // -------------------------------------------------------------------------
  // Writes — SUPER_ADMIN only
  // -------------------------------------------------------------------------

  @Post("products/:productId/barcodes")
  @Roles(Role.SUPER_ADMIN)
  async register(
    @CurrentUser() user: AuthenticatedUser,
    @Param("productId", new ParseUUIDPipe()) productId: string,
    @Body(new ZodValidationPipe(registerSchema)) body: RegisterInput,
  ) {
    const created = await this.barcodes.register(productId, user.sub, {
      barcode: body.barcode,
      symbology: body.symbology,
      isPrimary: body.isPrimary,
    });
    await this.audit.log({
      actorId: user.sub,
      actorRole: user.role,
      action: "admin.product_barcode.registered",
      resourceType: "product_barcode",
      resourceId: created.id,
      afterState: created as unknown as Prisma.InputJsonValue,
    });
    return created;
  }

  @Delete("product-barcodes/:id")
  @HttpCode(HttpStatus.NO_CONTENT)
  @Roles(Role.SUPER_ADMIN)
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", new ParseUUIDPipe()) id: string,
  ) {
    await this.barcodes.remove(id);
    await this.audit.log({
      actorId: user.sub,
      actorRole: user.role,
      action: "admin.product_barcode.removed",
      resourceType: "product_barcode",
      resourceId: id,
    });
  }
}
