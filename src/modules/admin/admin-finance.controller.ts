/**
 * Finance admin reads — vendor list with wallet balance + ledger
 * reconciliation report.
 *
 * Implementation Plan §6.4.2, §11.2 (Admin — Finance).
 */

import { Controller, Get, Query } from "@nestjs/common";
import { Role } from "@prisma/client";
import { z } from "zod";

import { Roles } from "../../common/decorators/roles.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { PrismaService } from "../../common/prisma.service";

const listVendorsSchema = z.object({
  search: z.string().min(1).max(120).optional(),
  status: z.enum(["PENDING_KYC", "ACTIVE", "SUSPENDED", "CLOSED"]).optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().positive().max(100).default(50),
});
type ListVendorsInput = z.infer<typeof listVendorsSchema>;

@Controller({ path: "admin", version: "1" })
@Roles(Role.FINANCE_ADMIN, Role.SUPER_ADMIN)
export class AdminFinanceController {
  constructor(private readonly prisma: PrismaService) {}

  @Get("vendors")
  async listVendors(@Query(new ZodValidationPipe(listVendorsSchema)) q: ListVendorsInput) {
    const where: {
      status?: ListVendorsInput["status"];
      OR?: Array<{ businessName?: { contains: string; mode: "insensitive" } } | { id?: { equals: string } }>;
    } = {};
    if (q.status) where.status = q.status;
    if (q.search) {
      where.OR = [{ businessName: { contains: q.search, mode: "insensitive" } }];
    }

    const items = await this.prisma.vendor.findMany({
      where,
      take: q.limit + 1,
      orderBy: { createdAt: "desc" },
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      include: { wallet: true },
    });
    let nextCursor: string | null = null;
    if (items.length > q.limit) {
      const next = items.pop();
      nextCursor = next?.id ?? null;
    }
    return {
      items: items.map((v) => ({
        id: v.id,
        businessName: v.businessName,
        country: v.country,
        kycStatus: v.kycStatus,
        status: v.status,
        wallet: v.wallet
          ? {
              balanceCents: v.wallet.balanceCents,
              status: v.wallet.status,
              lowBalanceThresholdCents: v.wallet.lowBalanceThresholdCents,
            }
          : null,
        createdAt: v.createdAt,
      })),
      nextCursor,
    };
  }

  /**
   * Cross-vendor reconciliation report. Returns every vendor whose
   * materialized balance differs from the sum of their ledger entries.
   * The daily cron writes the same comparison; this endpoint surfaces it
   * to finance admins on demand.
   */
  @Get("finance/reconciliation")
  async reconciliationReport() {
    // Pull every vendor + wallet + sum(ledger). N+1 acceptable for v1 since
    // N is small (50–200 vendors at launch). Replace with a single SQL
    // window-function query at scale.
    const vendors = await this.prisma.vendor.findMany({
      select: { id: true, businessName: true, wallet: { select: { balanceCents: true, status: true } } },
    });
    const sums = await this.prisma.ledgerEntry.groupBy({
      by: ["vendorId"],
      _sum: { amountCents: true },
    });
    const sumByVendor = new Map(sums.map((s) => [s.vendorId, s._sum.amountCents ?? 0]));

    const rows = vendors.map((v) => {
      const ledger = sumByVendor.get(v.id) ?? 0;
      const materialized = v.wallet?.balanceCents ?? 0;
      return {
        vendorId: v.id,
        businessName: v.businessName,
        materialized,
        ledger,
        deltaCents: materialized - ledger,
        walletStatus: v.wallet?.status ?? null,
      };
    });

    const discrepancies = rows.filter((r) => r.deltaCents !== 0);
    return {
      totals: {
        vendors: rows.length,
        clean: rows.length - discrepancies.length,
        discrepancies: discrepancies.length,
        totalMaterializedCents: rows.reduce((s, r) => s + r.materialized, 0),
        totalLedgerCents: rows.reduce((s, r) => s + r.ledger, 0),
      },
      discrepancies,
      // Always include a sample of clean rows for observability.
      cleanSample: rows.filter((r) => r.deltaCents === 0).slice(0, 10),
    };
  }
}
