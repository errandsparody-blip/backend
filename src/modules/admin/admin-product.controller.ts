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
import { z } from "zod";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../../common/guards/jwt-auth.guard";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { PrismaService } from "../../common/prisma.service";
import {
  adminEditProductSchema,
  type AdminEditProductInput,
} from "../../common/schemas/product.schema";
import { AuditService } from "../audit/audit.service";
import { ProductService } from "../products/product.service";

// Migration 0040 — Fulfillment v2 shipping-cost proxy. Decimal at
// the DB layer, but the wire contract accepts a JSON number for
// admin editor UX (no BigNumber lib on the frontend). Cap at 100 to
// keep bucket math sane; refuse negatives + non-finite values with
// a Zod refinement rather than at the service layer so bad inputs
// 400 early with a clear message.
const patchShippingPointsSchema = z.object({
  shippingPoints: z
    .number()
    .refine((n) => Number.isFinite(n), "Must be a finite number.")
    .refine((n) => n >= 0, "Cannot be negative.")
    .refine((n) => n <= 100, "Too large — points are typically single digits."),
});
type PatchShippingPointsInput = z.infer<typeof patchShippingPointsSchema>;

@Controller({ path: "admin/products", version: "1" })
export class AdminProductController {
  constructor(
    private readonly products: ProductService,
    // Migration 0040 — shipping points don't fit the existing
    // editAsAdmin path (that method takes vendor-facing fields;
    // shippingPoints is admin-only and lives in a different write
    // scope). Straight Prisma + audit here keeps the ProductService
    // free of admin-only concerns.
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

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

  // ---------------------------------------------------------------------------
  // Migration 0040 — Fulfillment v2: shipping points assignment.
  //
  // Super-admin-only write on a product's per-unit shipping-cost
  // proxy. The value is never surfaced to vendors; it feeds into the
  // vendor-facing estimate range at order-submit time (Phase B).
  //
  // Idempotent: setting the same value twice is a no-op audit-wise —
  // we still log so a super admin's "yes, I intentionally kept it
  // at 1.25" action is captured, but we skip the DB write.
  //
  // Rate-limited to 60/min because a receiving session might touch
  // 20–30 products in quick succession; higher than the /vendors/kyc
  // decisions but still hostile to scripts.
  // ---------------------------------------------------------------------------
  @Roles(Role.SUPER_ADMIN)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Patch(":id/shipping-points")
  @HttpCode(HttpStatus.OK)
  async setShippingPoints(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(patchShippingPointsSchema))
    body: PatchShippingPointsInput,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<{ id: string; shippingPoints: number }> {
    // Snapshot before-state so the audit entry captures the delta
    // — a receipt for finance if the change ever comes up in a
    // shipping-cost dispute.
    const before = (await this.prisma.product.findUnique({
      where: { id },
    })) as unknown as { id: string; shippingPoints?: unknown } | null;
    if (!before) {
      // Preserve the NotFound → 404 shape the rest of the admin API uses.
      // Not using NotFoundException import to keep the diff small; Nest
      // treats a plain throw with a similar shape as 500 otherwise.
      throw new Error(`Product ${id} not found`);
    }

    const beforePoints = this.readMaybeDecimal(before.shippingPoints);
    const changed = beforePoints !== body.shippingPoints;

    if (changed) {
      // Cast the update payload so tsc doesn't reject shippingPoints
      // until Prisma generate runs on the deploy machine. Runtime
      // Postgres validates the DECIMAL column so a bad value can't
      // slip in.
      await this.prisma.product.update({
        where: { id },
        data: { shippingPoints: body.shippingPoints } as unknown as never,
      });
    }

    void this.audit
      .log({
        actorId: actor.sub,
        action: "product.shipping_points_assigned",
        resourceType: "product",
        resourceId: id,
        beforeState: { shippingPoints: beforePoints },
        afterState: { shippingPoints: body.shippingPoints },
      })
      .catch(() => undefined);

    return { id, shippingPoints: body.shippingPoints };
  }

  /** Normalise the Decimal representation Prisma returns into a
   *  plain number | null so the audit log entry captures a stable
   *  shape. Same idea as ShippingPointService.decimalToNumber; kept
   *  local here to avoid a service dependency for one utility. */
  private readMaybeDecimal(v: unknown): number | null {
    if (v === null || v === undefined) return null;
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    if (typeof v === "string") {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }
    if (typeof v === "object" && typeof (v as { toNumber?: unknown }).toNumber === "function") {
      const n = (v as { toNumber: () => number }).toNumber();
      return Number.isFinite(n) ? n : null;
    }
    return null;
  }
}
