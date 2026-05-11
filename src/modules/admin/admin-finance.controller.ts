/**
 * Finance admin reads — vendor list with wallet balance + ledger
 * reconciliation report.
 *
 * Implementation Plan §6.4.2, §11.2 (Admin — Finance).
 */

import { Controller, Get, Query } from "@nestjs/common";
import { LedgerEntryType, Role } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { z } from "zod";

import { Roles } from "../../common/decorators/roles.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { PrismaService } from "../../common/prisma.service";

// All ledger types the admin transactions filter accepts. Mirrors the
// LedgerEntryType enum exactly; we re-declare the literal union here so
// the Zod schema is statically typed against the generated client.
const LEDGER_TYPES = [
  "DEPOSIT",
  "ONBOARDING",
  "STORAGE",
  "FULFILLMENT",
  "SHIPPING",
  "RETURN",
  "MANUAL_CREDIT",
  "MANUAL_DEBIT",
  "REVERSAL",
  "RECEIVING_HOLD_FEE",
  "PARTNERSHIP_ITEM_COST",
  "PURCHASE_FEE",
  "REFUND",
] as const;

const listTransactionsSchema = z.object({
  // Comma-separated list of ledger types. Empty = all.
  type: z.preprocess(
    (raw) => {
      if (typeof raw !== "string" || raw.trim() === "") return undefined;
      return raw
        .split(",")
        .map((v) => v.trim().toUpperCase())
        .filter((v) => v !== "");
    },
    z.array(z.enum(LEDGER_TYPES)).optional(),
  ),
  // Optional subject filter — "vendor" shows only wallet rows, "shopper"
  // shows only shopper-request rows. Default: both.
  subject: z.enum(["vendor", "shopper", "both"]).optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});
type ListTransactionsInput = z.infer<typeof listTransactionsSchema>;

// Pre-parse the kycStatus query param: comma-separated list → string[].
// `z.preprocess` keeps the schema's typed input/output equal so it slots into
// ZodValidationPipe<T>, which constrains its constructor to symmetric schemas.
const kycStatusEnum = z.enum([
  "PENDING",
  "IN_PROGRESS",
  "REQUIRES_RESUBMISSION",
  "APPROVED",
  "REJECTED",
  "EXPIRED",
]);

const listVendorsSchema = z.object({
  search: z.string().min(1).max(120).optional(),
  status: z.enum(["PENDING_KYC", "ACTIVE", "SUSPENDED", "CLOSED"]).optional(),
  // Filter by current KYC state. Useful for the KYC review queue, which
  // wants PENDING + IN_PROGRESS + REQUIRES_RESUBMISSION rows. The frontend
  // joins them with comma-separated `kycStatus=PENDING,IN_PROGRESS` syntax.
  kycStatus: z.preprocess(
    (raw) => {
      if (typeof raw !== "string" || raw.trim() === "") return undefined;
      return raw
        .split(",")
        .map((v) => v.trim().toUpperCase())
        .filter((v) => v !== "");
    },
    z.array(kycStatusEnum).optional(),
  ),
  cursor: z.string().uuid().optional(),
  // Optional. `.default()` would make the schema's input type asymmetric
  // (number | undefined → number) and ZodValidationPipe requires a symmetric
  // ZodSchema<T>. We default in the handler instead.
  limit: z.coerce.number().int().positive().max(100).optional(),
});
type ListVendorsInput = z.infer<typeof listVendorsSchema>;
const DEFAULT_LIMIT = 50;

@Controller({ path: "admin", version: "1" })
@Roles(Role.FINANCE_ADMIN, Role.SUPER_ADMIN)
export class AdminFinanceController {
  constructor(private readonly prisma: PrismaService) {}

  @Get("vendors")
  async listVendors(@Query(new ZodValidationPipe(listVendorsSchema)) q: ListVendorsInput) {
    const limit = q.limit ?? DEFAULT_LIMIT;
    const where: {
      status?: ListVendorsInput["status"];
      kycStatus?: { in: NonNullable<ListVendorsInput["kycStatus"]> };
      OR?: Array<{ businessName?: { contains: string; mode: "insensitive" } } | { id?: { equals: string } }>;
    } = {};
    if (q.status) where.status = q.status;
    if (q.kycStatus && q.kycStatus.length > 0) where.kycStatus = { in: q.kycStatus };
    if (q.search) {
      where.OR = [{ businessName: { contains: q.search, mode: "insensitive" } }];
    }

    const items = await this.prisma.vendor.findMany({
      where,
      take: limit + 1,
      orderBy: { createdAt: "desc" },
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      include: { wallet: true },
    });
    let nextCursor: string | null = null;
    if (items.length > limit) {
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
        socialVerifiedAt: v.socialVerifiedAt,
        hasSocialHandles:
          !!v.instagramHandle || !!v.tiktokHandle || !!v.xHandle || !!v.websiteUrl,
        agreementAcceptedAt: v.agreementAcceptedAt,
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

  /**
   * Unified transactions — every dollar movement on the platform.
   *
   * Returns both vendor-wallet ledger entries (vendorId set) and shopper
   * request rows (shopperRequestId set) interleaved by `createdAt`.
   * Filterable by transaction type (?type=ONBOARDING,SHIPPING,…) and by
   * subject (?subject=vendor|shopper|both).
   *
   * Per the product spec: "No vendor filter is needed in finance for now."
   * If we add one later, it goes here as `?vendorId=<uuid>`.
   */
  @Get("finance/transactions")
  async listTransactions(
    @Query(new ZodValidationPipe(listTransactionsSchema)) q: ListTransactionsInput,
  ) {
    const limit = q.limit ?? 50;
    // Build the WHERE as a loose record and cast at the call site. Migration
    // 0019 made vendor_id nullable + added shopper_request_id; the generated
    // Prisma client in this checkout still has the pre-migration shape until
    // `prisma generate` is re-run (sandbox can't reach the Prisma engine
    // CDN). Same cast pattern used in return.service.ts +
    // shopper-request.service.ts.
    const where: Record<string, unknown> = {};
    if (q.type && q.type.length > 0) {
      where.type = { in: q.type as LedgerEntryType[] };
    }
    if (q.subject === "vendor") {
      where.vendorId = { not: null };
    } else if (q.subject === "shopper") {
      where.shopperRequestId = { not: null };
    }
    // subject === "both" or undefined: no extra filter.

    const items = await this.prisma.ledgerEntry.findMany({
      where: where as unknown as Prisma.LedgerEntryWhereInput,
      take: limit + 1,
      orderBy: { createdAt: "desc" },
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      include: {
        vendor: { select: { id: true, businessName: true } },
        // Type cast — generated client may not yet include the shopperRequest
        // relation until `prisma generate` is re-run post-migration. The
        // runtime query is valid; this `as` makes the call compile against
        // the stale type. See migration 0019.
        ...({ shopperRequest: { select: { id: true, reference: true } } } as Record<
          string,
          unknown
        >),
      },
    });

    let nextCursor: string | null = null;
    if (items.length > limit) {
      const next = items.pop();
      nextCursor = next?.id ?? null;
    }

    return {
      items: items.map((e) => this.mapTransaction(e)),
      nextCursor,
    };
  }

  /** Shape a LedgerEntry row for the unified admin transactions view. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private mapTransaction(e: any) {
    return {
      id: e.id as string,
      type: e.type as LedgerEntryType,
      amountCents: e.amountCents as number,
      description: e.description as string,
      referenceType: (e.referenceType as string | null) ?? null,
      referenceId: (e.referenceId as string | null) ?? null,
      createdAt: e.createdAt as Date,
      // Subject can be vendor, shopper request, or (theoretically) neither —
      // the DB CHECK constraint rules out the last case. Frontend uses this
      // to render the row's "scope" badge.
      vendor: e.vendor
        ? { id: e.vendor.id as string, businessName: e.vendor.businessName as string }
        : null,
      shopperRequest: e.shopperRequest
        ? {
            id: e.shopperRequest.id as string,
            reference: e.shopperRequest.reference as string,
          }
        : null,
    };
  }
}
