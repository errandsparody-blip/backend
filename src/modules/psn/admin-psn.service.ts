/**
 * AdminPsnService — operator-side receiving workflow.
 *
 * The receiving transaction is the most correctness-sensitive flow in P1.
 * Every line acceptance is processed atomically:
 *   1. validate the line belongs to this PSN
 *   2. update the PSN line counts (received, accepted, damaged)
 *   3. if accepted_qty > 0, generate or stack into the SKU bucket
 *   4. write an InventoryMovement of type RECEIVE
 *   5. recompute PSN status (RECEIVED vs PARTIALLY_RECEIVED vs DISCREPANCY)
 *   6. audit-log
 *
 * If any step fails, the entire receiving event rolls back. No partial state.
 *
 * Implementation Plan §5.2, §6.2.2, §14.4.
 */

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { Prisma, PrismaClient, PsnStatus } from "@prisma/client";

import { PrismaService } from "../../common/prisma.service";
import type { CompleteReceivingInput, ListPsnsInput } from "../../common/schemas/psn.schema";
import { AuditService } from "../audit/audit.service";
import { SkuService } from "../sku/sku.service";

type Tx = Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">;

@Injectable()
export class AdminPsnService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly skus: SkuService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------------------
  // Cross-vendor reads (operator queue)
  // ---------------------------------------------------------------------------

  async listIncoming(input: ListPsnsInput) {
    const where: Prisma.PsnWhereInput = {
      // Default: only items relevant to receiving.
      status: input.status ?? { in: ["AWAITING_RECEIPT", "PARTIALLY_RECEIVED"] },
    };
    const psns = await this.prisma.psn.findMany({
      where,
      include: { lines: true, vendor: { select: { id: true, businessName: true } } },
      take: input.limit + 1,
      orderBy: { submittedAt: "asc" },
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    });
    let nextCursor: string | null = null;
    if (psns.length > input.limit) {
      const next = psns.pop();
      nextCursor = next?.id ?? null;
    }
    return { items: psns, nextCursor };
  }

  async get(id: string) {
    const psn = await this.prisma.psn.findUnique({
      where: { id },
      include: { lines: true, vendor: { select: { id: true, businessName: true, country: true } }, exceptions: true },
    });
    if (!psn) throw new NotFoundException();
    return psn;
  }

  // ---------------------------------------------------------------------------
  // Receiving — the transactional core
  // ---------------------------------------------------------------------------

  async completeReceiving(
    psnId: string,
    actorId: string,
    input: CompleteReceivingInput,
  ): Promise<{ status: PsnStatus; psnId: string }> {
    return this.prisma.$transaction(async (tx) => {
      const psn = await tx.psn.findUnique({ where: { id: psnId }, include: { lines: true } });
      if (!psn) throw new NotFoundException();
      if (!["AWAITING_RECEIPT", "PARTIALLY_RECEIVED"].includes(psn.status)) {
        throw new ConflictException({
          message: `PSN cannot be received from status ${psn.status}.`,
          code: "psn_wrong_status",
        });
      }

      // Build a quick lookup for declared lines.
      const declaredById = new Map(psn.lines.map((l) => [l.id, l]));

      // Validate each submitted line.
      for (const submitted of input.lines) {
        const declared = declaredById.get(submitted.lineId);
        if (!declared) {
          throw new BadRequestException({
            message: `Line ${submitted.lineId} is not part of this PSN.`,
            code: "psn_line_unknown",
          });
        }
        const total = submitted.acceptedQty + submitted.damagedQty;
        if (total > declared.declaredQty) {
          throw new BadRequestException({
            message: `Received total (${total}) exceeds declared (${declared.declaredQty}) for line ${submitted.lineId}.`,
            code: "psn_overreceive",
          });
        }
      }

      // Apply each line: update counts, generate SKUs, write movements.
      let anyDiscrepancy = false;
      let anyMissing = false;

      for (const submitted of input.lines) {
        const declared = declaredById.get(submitted.lineId)!;
        const total = submitted.acceptedQty + submitted.damagedQty;

        if (submitted.damagedQty > 0) anyDiscrepancy = true;
        if (total < declared.declaredQty) anyMissing = true;

        let skuId: string | null = declared.skuId;
        if (submitted.acceptedQty > 0) {
          skuId = await this.skus.receiveIntoBucket(tx as unknown as Tx, {
            vendorId: psn.vendorId,
            productId: declared.productId,
            // Receive into product's own variant; future enhancement: allow
            // operator to override at receiving time.
            variant: (await tx.product.findUnique({ where: { id: declared.productId } }))?.variant ?? "STD",
            qty: submitted.acceptedQty,
            psnId: psn.id,
            actorId,
          });
        }

        await tx.psnLine.update({
          where: { id: submitted.lineId },
          data: {
            receivedQty: total,
            acceptedQty: submitted.acceptedQty,
            damagedQty: submitted.damagedQty,
            ...(skuId ? { skuId } : {}),
            ...(submitted.notes !== undefined ? { notes: submitted.notes } : {}),
          },
        });
      }

      // Determine final PSN status.
      const next: PsnStatus = anyDiscrepancy
        ? "DISCREPANCY"
        : anyMissing
          ? "PARTIALLY_RECEIVED"
          : "RECEIVED";

      const updated = await tx.psn.update({
        where: { id: psn.id },
        data: {
          status: next,
          receivedAt: next === "RECEIVED" ? new Date() : psn.receivedAt,
        },
      });

      await this.audit.log({
        actorId,
        action: "psn.received",
        resourceType: "psn",
        resourceId: psn.id,
        beforeState: { status: psn.status },
        afterState: { status: updated.status, lines: input.lines.length },
      });

      return { status: updated.status, psnId: updated.id };
    });
  }
}
