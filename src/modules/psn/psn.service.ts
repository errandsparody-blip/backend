/**
 * PsnService — vendor-side PSN flow.
 *
 *   create()  — create as DRAFT, lines validated against vendor's products
 *   update()  — only when status === DRAFT
 *   submit()  — DRAFT → AWAITING_RECEIPT, snapshot the onboarding fee
 *   cancel()  — DRAFT → CANCELLED (only if not yet received)
 *   list()/get() — vendor-scoped reads
 *
 * Implementation Plan §5.2, §6.2.1, §6.3.1.
 */

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { Prisma, Psn, PsnStatus } from "@prisma/client";

import { computeOnboardingFeeCents, loadFeeSchedule, type DeclaredBoxCounts } from "../../common/fees";
import { PrismaService } from "../../common/prisma.service";
import type {
  CreatePsnInput,
  ListPsnsInput,
  UpdatePsnDraftInput,
} from "../../common/schemas/psn.schema";
import { AuditService } from "../audit/audit.service";
import { WalletService } from "../wallet/wallet.service";

export interface PublicPsn {
  id: string;
  status: PsnStatus;
  expectedArrivalDate: Date | null;
  carrier: string | null;
  masterTracking: string | null;
  declaredBoxCounts: DeclaredBoxCounts;
  notes: string | null;
  onboardingFeeCents: number | null;
  onboardingFeePaidAt: Date | null;
  submittedAt: Date | null;
  receivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  lines: Array<{
    id: string;
    productId: string;
    skuId: string | null;
    declaredQty: number;
    receivedQty: number;
    acceptedQty: number;
    damagedQty: number;
    notes: string | null;
  }>;
}

@Injectable()
export class PsnService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly wallet: WalletService,
  ) {}

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  async list(
    vendorId: string,
    input: ListPsnsInput,
  ): Promise<{ items: PublicPsn[]; nextCursor: string | null }> {
    const where: Prisma.PsnWhereInput = { vendorId };
    if (input.status) where.status = input.status;

    const psns = await this.prisma.psn.findMany({
      where,
      include: { lines: true },
      take: input.limit + 1,
      orderBy: { createdAt: "desc" },
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    });

    let nextCursor: string | null = null;
    if (psns.length > input.limit) {
      const next = psns.pop();
      nextCursor = next?.id ?? null;
    }
    return { items: psns.map((p) => this.toPublic(p)), nextCursor };
  }

  async get(vendorId: string, id: string): Promise<PublicPsn> {
    const psn = await this.prisma.psn.findFirst({
      where: { id, vendorId },
      include: { lines: true },
    });
    if (!psn) throw new NotFoundException();
    return this.toPublic(psn);
  }

  // ---------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------

  async create(vendorId: string, actorId: string, input: CreatePsnInput): Promise<PublicPsn> {
    // Verify every productId belongs to this vendor in a single round-trip.
    await this.assertProductsOwnedByVendor(
      vendorId,
      input.lines.map((l) => l.productId),
    );

    const psn = await this.prisma.psn.create({
      data: {
        vendorId,
        status: "DRAFT",
        expectedArrivalDate: input.expectedArrivalDate ?? null,
        carrier: input.carrier ?? null,
        masterTracking: input.masterTracking ?? null,
        declaredBoxCounts: input.declaredBoxCounts as Prisma.InputJsonValue,
        notes: input.notes ?? null,
        lines: {
          create: input.lines.map((l) => ({
            productId: l.productId,
            declaredQty: l.declaredQty,
            notes: l.notes ?? null,
          })),
        },
      },
      include: { lines: true },
    });

    await this.audit.log({
      actorId,
      action: "psn.created",
      resourceType: "psn",
      resourceId: psn.id,
      afterState: { status: psn.status, lineCount: input.lines.length },
    });
    return this.toPublic(psn);
  }

  async updateDraft(
    vendorId: string,
    actorId: string,
    id: string,
    patch: UpdatePsnDraftInput,
  ): Promise<PublicPsn> {
    const before = await this.prisma.psn.findFirst({ where: { id, vendorId } });
    if (!before) throw new NotFoundException();
    if (before.status !== "DRAFT") {
      throw new ConflictException({
        message: "Only DRAFT PSNs can be edited.",
        code: "psn_not_editable",
      });
    }

    if (patch.lines) {
      await this.assertProductsOwnedByVendor(
        vendorId,
        patch.lines.map((l) => l.productId),
      );
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      // Replace lines wholesale on update, simplest semantics for v1.
      if (patch.lines) {
        await tx.psnLine.deleteMany({ where: { psnId: id } });
      }
      return tx.psn.update({
        where: { id },
        data: {
          ...(patch.expectedArrivalDate !== undefined ? { expectedArrivalDate: patch.expectedArrivalDate } : {}),
          ...(patch.carrier !== undefined ? { carrier: patch.carrier } : {}),
          ...(patch.masterTracking !== undefined ? { masterTracking: patch.masterTracking } : {}),
          ...(patch.declaredBoxCounts !== undefined ? { declaredBoxCounts: patch.declaredBoxCounts as Prisma.InputJsonValue } : {}),
          ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
          ...(patch.lines
            ? {
                lines: {
                  create: patch.lines.map((l) => ({
                    productId: l.productId,
                    declaredQty: l.declaredQty,
                    notes: l.notes ?? null,
                  })),
                },
              }
            : {}),
        },
        include: { lines: true },
      });
    });

    await this.audit.log({
      actorId,
      action: "psn.updated",
      resourceType: "psn",
      resourceId: id,
    });
    return this.toPublic(updated);
  }

  async submit(vendorId: string, actorId: string, id: string): Promise<PublicPsn> {
    const before = await this.prisma.psn.findFirst({
      where: { id, vendorId },
      include: { lines: true },
    });
    if (!before) throw new NotFoundException();
    if (before.status !== "DRAFT") {
      throw new ConflictException({ message: "PSN already submitted.", code: "psn_not_draft" });
    }
    if (before.lines.length === 0) {
      throw new BadRequestException("PSN has no lines.");
    }

    const schedule = await loadFeeSchedule(this.prisma);
    const { totalCents } = computeOnboardingFeeCents(
      schedule,
      before.declaredBoxCounts as DeclaredBoxCounts,
    );

    // Debit the wallet for the onboarding fee + flip the PSN status atomically.
    // If the wallet has insufficient funds, the entire transaction rolls back —
    // the PSN stays a DRAFT, no ledger entry is written, no fee is locked in.
    // Implementation Plan §5.2 step 4, §6.4.
    const updated = await this.prisma.$transaction(async (tx) => {
      // Skip the debit when the fee is zero (e.g., declared only PALLETs which
      // are negotiated). We still flip the status; the operator-side flow
      // takes over from here.
      if (totalCents > 0) {
        await this.wallet.debit(
          {
            vendorId,
            amountCents: totalCents,
            type: "ONBOARDING",
            description: `Onboarding fee for PSN ${id.slice(0, 8)}`,
            referenceType: "psn",
            referenceId: id,
            actorId,
          },
          tx as unknown as Parameters<typeof this.wallet.debit>[1],
        );
      }
      return tx.psn.update({
        where: { id },
        data: {
          status: "AWAITING_RECEIPT",
          submittedAt: new Date(),
          onboardingFeeCents: totalCents,
          onboardingFeePaidAt: totalCents > 0 ? new Date() : null,
        },
        include: { lines: true },
      });
    });

    await this.audit.log({
      actorId,
      action: "psn.submitted",
      resourceType: "psn",
      resourceId: id,
      afterState: { onboardingFeeCents: totalCents },
    });
    return this.toPublic(updated);
  }

  async cancel(vendorId: string, actorId: string, id: string): Promise<PublicPsn> {
    const before = await this.prisma.psn.findFirst({ where: { id, vendorId } });
    if (!before) throw new NotFoundException();
    if (["RECEIVED", "PARTIALLY_RECEIVED", "DISCREPANCY"].includes(before.status)) {
      throw new ConflictException({
        message: "Cannot cancel a PSN that has been received.",
        code: "psn_already_received",
      });
    }
    const updated = await this.prisma.psn.update({
      where: { id },
      data: { status: "CANCELLED" },
      include: { lines: true },
    });
    await this.audit.log({
      actorId,
      action: "psn.cancelled",
      resourceType: "psn",
      resourceId: id,
      beforeState: { status: before.status },
    });
    return this.toPublic(updated);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async assertProductsOwnedByVendor(vendorId: string, productIds: string[]): Promise<void> {
    const ids = Array.from(new Set(productIds));
    if (ids.length === 0) return;
    const found = await this.prisma.product.findMany({
      where: { id: { in: ids }, vendorId },
      select: { id: true },
    });
    if (found.length !== ids.length) {
      throw new BadRequestException({
        message: "One or more products do not belong to this vendor.",
        code: "psn_invalid_product",
      });
    }
  }

  private toPublic(p: Psn & { lines: Array<{
    id: string; productId: string; skuId: string | null;
    declaredQty: number; receivedQty: number; acceptedQty: number; damagedQty: number;
    notes: string | null;
  }> }): PublicPsn {
    return {
      id: p.id,
      status: p.status,
      expectedArrivalDate: p.expectedArrivalDate,
      carrier: p.carrier,
      masterTracking: p.masterTracking,
      declaredBoxCounts: (p.declaredBoxCounts as DeclaredBoxCounts) ?? {},
      notes: p.notes,
      onboardingFeeCents: p.onboardingFeeCents,
      onboardingFeePaidAt: p.onboardingFeePaidAt,
      submittedAt: p.submittedAt,
      receivedAt: p.receivedAt,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      lines: p.lines.map((l) => ({
        id: l.id,
        productId: l.productId,
        skuId: l.skuId,
        declaredQty: l.declaredQty,
        receivedQty: l.receivedQty,
        acceptedQty: l.acceptedQty,
        damagedQty: l.damagedQty,
        notes: l.notes,
      })),
    };
  }
}
