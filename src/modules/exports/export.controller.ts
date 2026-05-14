/**
 * Vendor CSV exports — orders, ledger, inventory.
 *
 * Implementation Plan §6.10.
 *
 * All exports are:
 *   - vendor-scoped (the JWT's vendorId is the only allowed filter)
 *   - streamed (single-row buffering, no in-memory accumulation)
 *   - audit-logged (action: "export.<resource>") with row count
 *   - throttled (max 6 / minute per actor)
 *   - capped at 100k rows; clients must paginate via from/to ranges
 *
 * The CSV escaping defends against formula injection — see common/csv.ts.
 */

import {
  Controller,
  Get,
  Header,
  Query,
  Res,
  StreamableFile,
  UseGuards,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { Role } from "@prisma/client";
import type { Response } from "express";
import { z } from "zod";

import { csvHeaders, streamCsv } from "../../common/csv";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../../common/guards/jwt-auth.guard";
import { TenantGuard } from "../../common/guards/tenant.guard";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { PrismaService } from "../../common/prisma.service";
import { AuditService } from "../audit/audit.service";

const dateRangeSchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
type DateRange = z.infer<typeof dateRangeSchema>;

const MAX_ROWS = 100_000;

@Controller({ path: "exports", version: "1" })
@Roles(Role.VENDOR, Role.VENDOR_SUB_USER)
@UseGuards(TenantGuard)
export class ExportController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------------------
  // Orders
  // ---------------------------------------------------------------------------
  @Get("orders.csv")
  @Throttle({ default: { limit: 6, ttl: 60_000 } })
  @Header("Content-Type", "text/csv; charset=utf-8")
  async orders(
    @CurrentUser() user: AuthenticatedUser,
    @Query(new ZodValidationPipe(dateRangeSchema)) q: DateRange,
    @Res() res: Response,
  ): Promise<void> {
    const headers = csvHeaders(`orders_${this.dateStamp()}.csv`);
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);

    const where = {
      vendorId: user.vendorId!,
      ...(q.from || q.to
        ? { createdAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } }
        : {}),
    };

    let count = 0;
    const rows = (async function* (this: ExportController) {
      let cursor: string | undefined;
      while (count < MAX_ROWS) {
        const batch = await this.prisma.order.findMany({
          where,
          orderBy: { createdAt: "asc" },
          take: 500,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        });
        if (batch.length === 0) break;
        for (const o of batch) {
          if (count >= MAX_ROWS) break;
          yield [
            o.id,
            // Platform-assigned numeric order number — present in the export
            // alongside the vendor's own external_reference so downstream
            // spreadsheets can join either way.
            String(o.orderNumber),
            o.externalReference ?? "",
            o.status,
            o.recipientName,
            o.shipCity,
            o.shipState,
            o.shipPostalCode,
            o.shipCountry,
            o.carrier ?? "",
            o.carrierService ?? "",
            o.trackingNumber ?? "",
            (o.itemsDeclaredValueCents / 100).toFixed(2),
            (o.shippingFeeCents / 100).toFixed(2),
            (o.fulfillmentFeeCents / 100).toFixed(2),
            (o.insuranceFeeCents / 100).toFixed(2),
            (o.reassessmentDeltaCents / 100).toFixed(2),
            (o.totalChargedCents / 100).toFixed(2),
            o.submittedAt ? o.submittedAt.toISOString() : "",
            o.shippedAt ? o.shippedAt.toISOString() : "",
            o.deliveredAt ? o.deliveredAt.toISOString() : "",
            o.cancelledAt ? o.cancelledAt.toISOString() : "",
            o.cancelReason ?? "",
            o.createdAt.toISOString(),
          ];
          count++;
        }
        cursor = batch[batch.length - 1]!.id;
        if (batch.length < 500) break;
      }
    }).call(this);

    await streamCsv(
      res,
      [
        "id",
        "order_number",
        "external_reference",
        "status",
        "recipient_name",
        "ship_city",
        "ship_state",
        "ship_postal_code",
        "ship_country",
        "carrier",
        "carrier_service",
        "tracking_number",
        "items_declared_value_usd",
        "shipping_fee_usd",
        "fulfillment_fee_usd",
        "insurance_fee_usd",
        "reassessment_delta_usd",
        "total_charged_usd",
        "submitted_at",
        "shipped_at",
        "delivered_at",
        "cancelled_at",
        "cancel_reason",
        "created_at",
      ],
      rows,
    );

    await this.audit.log({
      actorId: user.sub,
      action: "export.orders",
      resourceType: "order",
      afterState: { rowCount: count, from: q.from?.toISOString() ?? null, to: q.to?.toISOString() ?? null },
    });
  }

  // ---------------------------------------------------------------------------
  // Ledger
  // ---------------------------------------------------------------------------
  @Get("ledger.csv")
  @Throttle({ default: { limit: 6, ttl: 60_000 } })
  @Header("Content-Type", "text/csv; charset=utf-8")
  async ledger(
    @CurrentUser() user: AuthenticatedUser,
    @Query(new ZodValidationPipe(dateRangeSchema)) q: DateRange,
    @Res() res: Response,
  ): Promise<void> {
    const headers = csvHeaders(`ledger_${this.dateStamp()}.csv`);
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);

    const where = {
      vendorId: user.vendorId!,
      ...(q.from || q.to
        ? { createdAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } }
        : {}),
    };

    let count = 0;
    const rows = (async function* (this: ExportController) {
      let cursor: string | undefined;
      while (count < MAX_ROWS) {
        const batch = await this.prisma.ledgerEntry.findMany({
          where,
          orderBy: { createdAt: "asc" },
          take: 500,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        });
        if (batch.length === 0) break;
        for (const e of batch) {
          if (count >= MAX_ROWS) break;
          yield [
            e.id,
            e.createdAt.toISOString(),
            e.type,
            (e.amountCents / 100).toFixed(2),
            // Migration 0019 made `balance_after_cents` nullable to
            // support shopper-side ledger rows. The query above is
            // vendor-scoped so these rows will always have a snapshot,
            // but the type is now `number | null` — coerce to 0 (and
            // render as a blank cell would be confusing in a CSV) so
            // the column stays parseable.
            ((e.balanceAfterCents ?? 0) / 100).toFixed(2),
            e.description,
            e.referenceType ?? "",
            e.referenceId ?? "",
          ];
          count++;
        }
        cursor = batch[batch.length - 1]!.id;
        if (batch.length < 500) break;
      }
    }).call(this);

    await streamCsv(
      res,
      ["id", "created_at", "type", "amount_usd", "balance_after_usd", "description", "reference_type", "reference_id"],
      rows,
    );

    await this.audit.log({
      actorId: user.sub,
      action: "export.ledger",
      resourceType: "ledger",
      afterState: { rowCount: count, from: q.from?.toISOString() ?? null, to: q.to?.toISOString() ?? null },
    });
  }

  // ---------------------------------------------------------------------------
  // Inventory
  // ---------------------------------------------------------------------------
  @Get("inventory.csv")
  @Throttle({ default: { limit: 6, ttl: 60_000 } })
  @Header("Content-Type", "text/csv; charset=utf-8")
  async inventory(
    @CurrentUser() user: AuthenticatedUser,
    @Res() res: Response,
  ): Promise<StreamableFile | void> {
    const headers = csvHeaders(`inventory_${this.dateStamp()}.csv`);
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);

    let count = 0;
    const rows = (async function* (this: ExportController) {
      let cursor: string | undefined;
      while (count < MAX_ROWS) {
        const batch = await this.prisma.sku.findMany({
          where: { vendorId: user.vendorId! },
          include: { product: { select: { code: true, name: true, hsCode: true, countryOfOrigin: true } } },
          orderBy: { createdAt: "asc" },
          take: 500,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        });
        if (batch.length === 0) break;
        for (const s of batch) {
          if (count >= MAX_ROWS) break;
          yield [
            s.id,
            s.product.code,
            s.product.name,
            s.variant,
            s.product.hsCode ?? "",
            s.product.countryOfOrigin,
            s.storageTier,
            s.warehouseLocation ?? "",
            s.status,
            s.quantityAvailable,
            s.quantityReserved,
            s.createdAt.toISOString(),
            s.updatedAt.toISOString(),
          ];
          count++;
        }
        cursor = batch[batch.length - 1]!.id;
        if (batch.length < 500) break;
      }
    }).call(this);

    await streamCsv(
      res,
      [
        "sku_id",
        "product_code",
        "product_name",
        "variant",
        "hs_code",
        "country_of_origin",
        "storage_tier",
        "warehouse_location",
        "status",
        "quantity_available",
        "quantity_reserved",
        "created_at",
        "updated_at",
      ],
      rows,
    );

    await this.audit.log({
      actorId: user.sub,
      action: "export.inventory",
      resourceType: "sku",
      afterState: { rowCount: count },
    });
  }

  // ---------------------------------------------------------------------------

  private dateStamp(): string {
    return new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  }
}
