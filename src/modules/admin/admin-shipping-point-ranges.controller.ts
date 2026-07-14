/**
 * Admin shipping-point ranges controller — dedicated endpoints for
 * the vendor-facing estimate range table (Fulfillment v2 config).
 *
 * Introduced by migration 0040.
 *
 *   GET   /v1/admin/shipping-point-ranges       fresh read + defaults
 *   PATCH /v1/admin/shipping-point-ranges       replace the range table
 *
 * SUPER_ADMIN only. Kept off the generic AdminConfigController for
 * three reasons:
 *
 *   1. Writes flow through ShippingPointService.writeTable which
 *      validates shape + bucket coherence (no overlaps, ordered).
 *      The generic PATCH would accept whatever JSON was posted and
 *      leave the runtime resolver to fall back silently — that's
 *      correct behaviour but a bad UX for the editor.
 *
 *   2. GET returns the compiled-in defaults alongside the current
 *      state so the editor can render a "reset to defaults" button
 *      without an extra endpoint.
 *
 *   3. Audit trail: every PATCH writes a scoped
 *      `admin.shipping_point_ranges.updated` entry. Grepping the
 *      audit log for "who last changed the range table" is a
 *      first-class query.
 */

import { Body, Controller, Get, HttpCode, HttpStatus, Patch } from "@nestjs/common";
import { Prisma, Role } from "@prisma/client";
import { z } from "zod";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../../common/guards/jwt-auth.guard";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import {
  DEFAULT_SHIPPING_POINT_RANGES,
  SHIPPING_POINT_RANGES_CONFIG_KEY,
  type ShippingPointRangeTable,
} from "../../common/schemas/shipping-points";
import { ShippingPointService } from "../../common/services/shipping-point.service";
import { AuditService } from "../audit/audit.service";

// Zod for the wire shape. Bucket coherence (no overlap, min<max, etc.)
// is enforced by ShippingPointService.writeTable — Zod stops the
// obvious errors early so we return a clean 400 message; anything
// subtler gets caught server-side.
const bucketSchema = z.object({
  pointsMin: z.number().min(0).finite(),
  pointsMax: z.number().positive().finite(),
  dollarsMin: z.number().int().min(0),
  dollarsMax: z.number().int().min(0),
});

const patchSchema = z.object({
  buckets: z.array(bucketSchema).min(1, "At least one bucket is required."),
});
type PatchInput = z.infer<typeof patchSchema>;

@Controller({ path: "admin/shipping-point-ranges", version: "1" })
@Roles(Role.SUPER_ADMIN)
export class AdminShippingPointRangesController {
  constructor(
    private readonly points: ShippingPointService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Fresh read (skips the 30s per-process cache) so the editor
   * matrix reflects the actual persisted state after a Save
   * round-trip. Returns the current table + the compiled-in
   * defaults so the UI can render a "reset to default" affordance
   * without a second call.
   */
  @Get()
  async get(): Promise<{
    current: ShippingPointRangeTable;
    defaults: ShippingPointRangeTable;
  }> {
    const current = await this.points.readTableFresh();
    return { current, defaults: DEFAULT_SHIPPING_POINT_RANGES };
  }

  @Patch()
  @HttpCode(HttpStatus.OK)
  async patch(
    @CurrentUser() actor: AuthenticatedUser,
    @Body(new ZodValidationPipe(patchSchema)) body: PatchInput,
  ): Promise<{ current: ShippingPointRangeTable }> {
    const before = await this.points.readTableFresh();
    let after: ShippingPointRangeTable;
    try {
      after = await this.points.writeTable(body);
    } catch {
      // ShippingPointService.writeTable throws
      // "shipping_point_range_table_invalid" for shape issues Zod
      // couldn't catch (overlap, dollars-min > dollars-max, etc.).
      // Surface as 400 so the editor renders a meaningful message.
      throw new Error("Range table failed validation: overlapping buckets or invalid dollar bounds.");
    }

    void this.audit
      .log({
        actorId: actor.sub,
        action: "admin.shipping_point_ranges.updated",
        resourceType: "configuration",
        resourceId: SHIPPING_POINT_RANGES_CONFIG_KEY,
        // Cast through Prisma.InputJsonValue — ShippingPointRangeTable
        // is structurally a JSON object but TS doesn't recognise it as
        // the Prisma-generated JSON union without an explicit cast.
        beforeState: before as unknown as Prisma.InputJsonValue,
        afterState: after as unknown as Prisma.InputJsonValue,
      })
      .catch(() => undefined);

    return { current: after };
  }
}
