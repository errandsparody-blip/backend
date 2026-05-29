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
import { computeFirstBillingDate, SkuService } from "../sku/sku.service";
import { WalletService } from "../wallet/wallet.service";

// Default window before a stale PsnHold auto-converts to RETURN_REQUESTED.
// 7 days is long enough for a vendor to notice the dashboard banner /
// email and pay, short enough that the package isn't sitting in the
// warehouse forever.
const HOLD_RELEASE_DAYS = 7;

type Tx = Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">;

@Injectable()
export class AdminPsnService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly skus: SkuService,
    private readonly audit: AuditService,
    private readonly wallet: WalletService,
  ) {}

  // ---------------------------------------------------------------------------
  // Cross-vendor reads (operator queue)
  // ---------------------------------------------------------------------------

  /**
   * Cross-vendor PSN list used by both the receiving inbox (default —
   * AWAITING_RECEIPT + PARTIALLY_RECEIVED, ordered by submittedAt asc so
   * oldest shipments surface first) and the receiving History tab
   * (caller passes a comma list of terminal statuses like
   * "RECEIVED,DISCREPANCY,REJECTED,RETURN_REQUESTED" and we order by
   * receivedAt desc so the most-recently-processed PSNs come back
   * first).
   *
   * Tenant scoping: super admin can pass `vendorId` to drill into a
   * single vendor's history without losing the cross-vendor query
   * surface. Without it, every vendor's PSNs are returned.
   */
  async listIncoming(input: ListPsnsInput) {
    // Normalise status into a Prisma filter regardless of whether the
    // caller passed a single value (legacy single-string form) or a
    // comma-list (history-tab multi-status form).
    let statusFilter: Prisma.PsnWhereInput["status"];
    if (input.status === undefined) {
      statusFilter = { in: ["AWAITING_RECEIPT", "PARTIALLY_RECEIVED"] };
    } else if (Array.isArray(input.status)) {
      statusFilter = { in: input.status };
    } else {
      statusFilter = input.status;
    }

    // Detect "history mode" — any query that touches a terminal status
    // (RECEIVED / DISCREPANCY / REJECTED / RETURN_REQUESTED) should
    // order by receivedAt desc so the operator sees the most-recent
    // shipment first. The default inbox view stays submittedAt asc so
    // the oldest queued shipment surfaces at the top.
    const HISTORY_STATUSES = new Set([
      "RECEIVED",
      "DISCREPANCY",
      "REJECTED",
      "RETURN_REQUESTED",
    ]);
    const statusList: string[] = Array.isArray(input.status)
      ? input.status
      : input.status
      ? [input.status]
      : [];
    const isHistoryView = statusList.some((s) => HISTORY_STATUSES.has(s));

    const where: Prisma.PsnWhereInput = {
      status: statusFilter,
      ...(input.vendorId ? { vendorId: input.vendorId } : {}),
    };
    const psns = await this.prisma.psn.findMany({
      where,
      include: { lines: true, vendor: { select: { id: true, businessName: true } } },
      take: input.limit + 1,
      orderBy: isHistoryView
        ? [{ receivedAt: "desc" }, { submittedAt: "desc" }]
        : { submittedAt: "asc" },
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
      include: {
        // Migration 0024 — include the product's storageTier on each
        // line so the admin receive page can render a "Tier size"
        // column (dimensions sourced from the tier_dimensions config
        // row on the frontend). The product include also keeps the
        // existing code/name/variant available.
        lines: {
          include: {
            product: {
              select: {
                id: true,
                code: true,
                name: true,
                variant: true,
                // `storageTier` is on the Product model (migration 0010).
                // `imageUrl` was added in migration 0022. Both flow
                // through this cast because Railway's stale Prisma
                // client may not know about either column until the
                // next `prisma generate` runs. Surfacing the locked
                // product image here lets the admin receive page
                // visually match incoming stock without an extra hop.
                ...({ storageTier: true, imageUrl: true } as Record<string, unknown>),
              },
            },
          },
        },
        vendor: { select: { id: true, businessName: true, country: true } },
        exceptions: true,
        // Migration 0020 — include hold lifecycle so the receive page can
        // render the current state. Limit to the most-recent for display;
        // the audit log has the full history if anyone needs it.
        ...({ holds: { orderBy: { createdAt: "desc" }, take: 5 } } as Record<string, unknown>),
      },
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
          // Pull both the variant and the storage tier from the product so
          // the resulting SKU bucket lands in the right tier for monthly
          // storage billing. Pre-0010 rows default to SMALL on the Product
          // side, so this is always defined at runtime. The cast handles
          // the stale Prisma client (which doesn't yet know about
          // storage_tier on Product) — `prisma generate` updates it on
          // deploy.
          const product = (await tx.product.findUnique({
            where: { id: declared.productId },
          })) as null | {
            variant: string;
            storageTier: "SMALL" | "MEDIUM" | "LARGE" | "X_LARGE" | "PALLET";
          };
          skuId = await this.skus.receiveIntoBucket(tx as unknown as Tx, {
            vendorId: psn.vendorId,
            productId: declared.productId,
            // Receive into product's own variant; future enhancement: allow
            // operator to override at receiving time.
            variant: product?.variant ?? "STD",
            qty: submitted.acceptedQty,
            psnId: psn.id,
            actorId,
            storageTier: product?.storageTier,
          });
        }

        await tx.psnLine.update({
          where: { id: submitted.lineId },
          data: {
            receivedQty: total,
            acceptedQty: submitted.acceptedQty,
            damagedQty: submitted.damagedQty,
            // Migration 0024 — capture the missing count alongside damaged.
            // Cast around the stale Prisma client (the column is in 0024,
            // generated client catches up post-deploy).
            ...({ missingQty: submitted.missingQty ?? 0 } as Record<string, unknown>),
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

      // Migration 0035 — create one StorageBox row per physical box the
      // vendor declared in this shipment. This is the new billing unit
      // (replaces SKU-based storage billing): the daily cron iterates
      // these rows, debits per box on its 30-day anchor, and admin can
      // mark them empty / removed via the consolidate UI.
      //
      // Migration 0036 — ADD_TO_PALLET PSNs now ALSO create StorageBox
      // rows, but with nextBillingDate=null so the cron skips them.
      // That keeps the vendor's recurring-storage view honest (they see
      // every box they paid stocking on) without double-billing — the
      // parent pallet's $45/mo keeps covering them.
      //
      // Guards:
      //   - Skip if boxes already exist for this PSN (idempotent on
      //     re-submission of the receive form).
      //   - Pull declaredBoxCounts from the up-to-date PSN row so any
      //     in-receive correction by the operator is honoured.
      await this.createStorageBoxesIfNeeded(
        tx as unknown as Tx,
        updated.id,
        updated.vendorId,
        (updated.declaredBoxCounts ?? {}) as Record<string, number>,
        updated.receivedAt ?? new Date(),
        updated.shippingMode,
      );

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

  /**
   * Insert one StorageBox row per declared box, anchored to receivedAt.
   * No-op when boxes already exist for this PSN (idempotent on retry).
   *
   * The `shippingMode` argument governs which rows actually bill:
   *
   *   LOOSE          — every row bills independently on its 30-day anchor.
   *
   *   PALLET         — the PALLET-tier row(s) bill at the $45/mo pallet
   *                    rate. Inner-tier rows (LARGE / MEDIUM / SMALL /
   *                    X_LARGE) are stored with nextBillingDate=null so
   *                    the cron skips them — they're physically present
   *                    and visible on the recurring-storage page, but
   *                    the pallet's $45/mo already covers them. Without
   *                    this, a 1-pallet × 5-LARGE shipment would bill
   *                    $45 + 5×$18 = $135 instead of $45 (the bug this
   *                    branch fixes; see also migration 0036 backfill).
   *
   *   ADD_TO_PALLET  — every row uses nextBillingDate=null. The boxes
   *                    ride inside an existing pallet that's already on
   *                    the books and billing $45/mo elsewhere; no row
   *                    on this PSN should bill on its own.
   *
   * For PALLET mode, when there is a single inner tier (the common case:
   * "1 pallet of 5 LARGE"), the helper populates `palletContentTier` /
   * `palletContentCount` on the pallet row(s) so the UI can render
   * "PALLET — 5 LARGE boxes inside" without an extra consolidate step.
   * Mixed-tier pallets leave those fields null for admin to fill in.
   */
  private async createStorageBoxesIfNeeded(
    tx: Tx,
    psnId: string,
    vendorId: string,
    declaredBoxCounts: Record<string, number>,
    receivedAt: Date,
    shippingMode: "LOOSE" | "PALLET" | "ADD_TO_PALLET" = "LOOSE",
  ): Promise<void> {
    const existing = await tx.storageBox.count({ where: { psnId } });
    if (existing > 0) return;

    const isPalletMode = shippingMode === "PALLET";
    const isAddToPalletMode = shippingMode === "ADD_TO_PALLET";
    const billDateForBillingRows: Date = computeFirstBillingDate(receivedAt);

    // Normalise + filter the declared counts into a clean list. Anything
    // that isn't a real StorageTier or a positive integer is dropped here
    // so the row-building loop below stays simple.
    const VALID_TIERS = ["SMALL", "MEDIUM", "LARGE", "X_LARGE", "PALLET"] as const;
    type Tier = (typeof VALID_TIERS)[number];
    const entries: Array<{ tier: Tier; count: number }> = [];
    for (const [tier, rawCount] of Object.entries(declaredBoxCounts)) {
      const count =
        typeof rawCount === "number" ? rawCount : Number.parseInt(String(rawCount), 10);
      if (!Number.isFinite(count) || count <= 0) continue;
      if (!(VALID_TIERS as readonly string[]).includes(tier)) continue;
      entries.push({ tier: tier as Tier, count });
    }
    if (entries.length === 0) return;

    // For PALLET mode, work out the inner-tier story so we can populate
    // `palletContentTier` / `palletContentCount` on the pallet row(s)
    // when the shipment is single-tier (the common case).
    let palletContentTier: Tier | null = null;
    let totalInnerBoxes = 0;
    if (isPalletMode) {
      const innerTiers = entries.filter((e) => e.tier !== "PALLET");
      totalInnerBoxes = innerTiers.reduce((sum, e) => sum + e.count, 0);
      // Only populate palletContentTier when there's exactly one inner
      // tier (e.g. all 5 inner boxes are LARGE). Mixed-tier pallets
      // can't be represented in a single column, so we leave the field
      // null and let admin fill it in via the consolidate dialog.
      palletContentTier =
        innerTiers.length === 1 && innerTiers[0] !== undefined ? innerTiers[0].tier : null;
    }
    const palletCount = isPalletMode
      ? (entries.find((e) => e.tier === "PALLET")?.count ?? 0)
      : 0;
    // When palletContentTier is known and there's exactly one pallet,
    // every inner box can be attributed to it. Multi-pallet shipments
    // distribute evenly (5 LARGE across 2 pallets → ~2 each); the math
    // doesn't have to be perfect because the inner rows aren't billing —
    // it's only a display hint for the pallet's contents line.
    const innerPerPallet =
      palletContentTier !== null && palletCount > 0
        ? Math.round(totalInnerBoxes / palletCount)
        : null;

    const rows: Array<{
      vendorId: string;
      psnId: string;
      tier: Tier;
      receivedAt: Date;
      nextBillingDate: Date | null;
      palletContentTier: Tier | null;
      palletContentCount: number | null;
    }> = [];

    for (const { tier, count } of entries) {
      const isInnerTier = tier !== "PALLET";

      // Bill-date decision tree:
      //   ADD_TO_PALLET → every row bundled (null)
      //   PALLET + inner tier → bundled into the pallet's row (null)
      //   PALLET + PALLET tier → bills (the pallet itself)
      //   LOOSE → bills
      let billDate: Date | null;
      if (isAddToPalletMode) {
        billDate = null;
      } else if (isPalletMode && isInnerTier) {
        billDate = null;
      } else {
        billDate = billDateForBillingRows;
      }

      // Contents annotation only applies to PALLET-tier rows in PALLET
      // mode with a single inner tier. Everything else is null.
      const contentTier: Tier | null =
        isPalletMode && tier === "PALLET" && palletContentTier !== null
          ? palletContentTier
          : null;
      const contentCount: number | null =
        contentTier !== null && innerPerPallet !== null ? innerPerPallet : null;

      for (let i = 0; i < count; i++) {
        rows.push({
          vendorId,
          psnId,
          tier,
          receivedAt,
          nextBillingDate: billDate,
          palletContentTier: contentTier,
          palletContentCount: contentCount,
        });
      }
    }

    if (rows.length === 0) return;
    await tx.storageBox.createMany({ data: rows });
  }

  // ---------------------------------------------------------------------------
  // Phase 2 — admin actions beyond simple Accept.
  //
  // Five total user-facing actions on the receive page; the existing
  // completeReceiving covers two of them (Accept + Edit & Accept — same
  // backend, the frontend just pre-fills "received = declared" for Accept).
  // The four below add the new outcomes.
  // ---------------------------------------------------------------------------

  /**
   * Return the currently-active (PENDING_PAYMENT) hold for a PSN, or null.
   * Vendor-side endpoint uses this to render the "Pay $X to release" banner.
   * Tenant scoping: if `vendorId` is given, the hold is only returned when
   * the PSN belongs to that vendor — otherwise null, indistinguishably from
   * "no active hold" to avoid leaking PSN existence across tenants.
   */
  async activeHoldFor(
    psnId: string,
    vendorId?: string,
  ): Promise<{
    id: string;
    extraChargeCents: number;
    reasonCode: string;
    reasonNote: string;
    releaseAfter: string;
  } | null> {
    const psn = await this.prisma.psn.findUnique({
      where: { id: psnId },
      select: { id: true, vendorId: true, status: true },
    });
    if (!psn) return null;
    if (vendorId && psn.vendorId !== vendorId) return null;
    if ((psn.status as string) !== "HOLD") return null;

    const hold = (await (
      this.prisma as unknown as {
        psnHold: {
          findFirst: (a: unknown) => Promise<{
            id: string;
            extraChargeCents: number;
            reasonCode: string;
            reasonNote: string;
            releaseAfter: Date;
          } | null>;
        };
      }
    ).psnHold.findFirst({
      where: { psnId, status: "PENDING_PAYMENT" },
      orderBy: { createdAt: "desc" },
    })) as
      | { id: string; extraChargeCents: number; reasonCode: string; reasonNote: string; releaseAfter: Date }
      | null;

    if (!hold) return null;
    return {
      id: hold.id,
      extraChargeCents: hold.extraChargeCents,
      reasonCode: hold.reasonCode,
      reasonNote: hold.reasonNote,
      releaseAfter: hold.releaseAfter.toISOString(),
    };
  }

  /**
   * Place the PSN on HOLD with a pending-payment record. The vendor's wallet
   * is NOT debited yet — they have to view their dashboard, see the banner,
   * and either pay (top-up first if balance is short) or refuse.
   *
   * Allowed from: AWAITING_RECEIPT, PARTIALLY_RECEIVED, DISCREPANCY.
   * Refused from: anything else (would orphan inventory or money flow).
   */
  async placeHold(
    psnId: string,
    actorId: string,
    input: { extraChargeCents: number; reasonCode: string; reasonNote: string },
  ): Promise<{ psnId: string; holdId: string; status: PsnStatus }> {
    return this.prisma.$transaction(async (tx) => {
      const psn = await tx.psn.findUnique({ where: { id: psnId } });
      if (!psn) throw new NotFoundException();
      if (!["AWAITING_RECEIPT", "PARTIALLY_RECEIVED", "DISCREPANCY"].includes(psn.status)) {
        throw new ConflictException({
          message: `PSN cannot be held from status ${psn.status}.`,
          code: "psn_hold_blocked",
        });
      }
      // Refuse to stack a new hold if one is already pending. The receive
      // page should never let admin reach this, but defence in depth.
      const existing = await (
        tx as unknown as { psnHold: { findFirst: (a: unknown) => Promise<unknown> } }
      ).psnHold.findFirst({
        where: { psnId, status: "PENDING_PAYMENT" },
      });
      if (existing) {
        throw new ConflictException({
          message: "An active hold is already pending payment for this PSN.",
          code: "psn_hold_already_active",
        });
      }

      const releaseAfter = new Date(Date.now() + HOLD_RELEASE_DAYS * 24 * 60 * 60 * 1000);

      const hold = await (
        tx as unknown as {
          psnHold: { create: (a: unknown) => Promise<{ id: string }> };
        }
      ).psnHold.create({
        data: {
          psnId,
          extraChargeCents: input.extraChargeCents,
          reasonCode: input.reasonCode,
          reasonNote: input.reasonNote,
          status: "PENDING_PAYMENT",
          createdBy: actorId,
          releaseAfter,
        },
      });

      const updated = await tx.psn.update({
        where: { id: psnId },
        data: { status: "HOLD" as PsnStatus },
      });

      await this.audit.log({
        actorId,
        action: "psn.held",
        resourceType: "psn",
        resourceId: psnId,
        beforeState: { status: psn.status },
        afterState: {
          status: updated.status,
          holdId: hold.id,
          extraChargeCents: input.extraChargeCents,
          reasonCode: input.reasonCode,
        },
      });

      return { psnId, holdId: hold.id, status: updated.status };
    });
  }

  /**
   * Reject the PSN outright. No inventory created. The vendor's onboarding
   * fee debit (from submit) is NOT refunded automatically — that's a
   * separate finance decision. Allowed from any pre-receipt state.
   */
  async reject(
    psnId: string,
    actorId: string,
    input: { reason: string },
  ): Promise<{ psnId: string; status: PsnStatus }> {
    const REJECTABLE = ["AWAITING_RECEIPT", "PARTIALLY_RECEIVED", "DISCREPANCY", "HOLD"];

    const result = await this.prisma.$transaction(async (tx) => {
      const psn = await tx.psn.findUnique({ where: { id: psnId } });
      if (!psn) throw new NotFoundException();
      if (!REJECTABLE.includes(psn.status)) {
        throw new ConflictException({
          message: `PSN in status ${psn.status} cannot be rejected.`,
          code: "psn_reject_blocked",
        });
      }

      // Cancel any pending hold so the auto-return cron doesn't double-process.
      await (
        tx as unknown as {
          psnHold: {
            updateMany: (a: unknown) => Promise<{ count: number }>;
          };
        }
      ).psnHold.updateMany({
        where: { psnId, status: "PENDING_PAYMENT" },
        data: { status: "CANCELLED" },
      });

      const updated = await tx.psn.update({
        where: { id: psnId },
        data: {
          status: "REJECTED" as PsnStatus,
          rejectedReason: input.reason,
          rejectedAt: new Date(),
        } as unknown as Prisma.PsnUpdateInput,
      });

      return { before: psn.status, updated };
    });

    await this.audit.log({
      actorId,
      action: "psn.rejected",
      resourceType: "psn",
      resourceId: psnId,
      beforeState: { status: result.before },
      afterState: { status: result.updated.status, reason: input.reason },
    });

    return { psnId, status: result.updated.status };
  }

  /**
   * Close out a DISCREPANCY PSN with the previously-recorded
   * quantities accepted as final. Used when the operator has
   * physically reconciled the shipment with the vendor (e.g. the
   * vendor confirmed the missing items were never sent, or a follow-up
   * conversation established that the partial receipt is final) and
   * just needs to stop the PSN from sitting in DISCREPANCY forever.
   *
   * Does NOT change line quantities or create additional inventory —
   * everything that was going to be received already was during the
   * original `completeReceiving` call. This action only flips the PSN
   * status to RECEIVED and records the reconciliation note in the
   * audit log.
   *
   * Allowed from: DISCREPANCY only. Use `reject` or `requestReturn`
   * if the resolution is "send it back" rather than "accept as-is".
   */
  async resolveDiscrepancy(
    psnId: string,
    actorId: string,
    input: { resolutionNote: string },
  ): Promise<{ psnId: string; status: PsnStatus }> {
    const result = await this.prisma.$transaction(async (tx) => {
      const psn = await tx.psn.findUnique({ where: { id: psnId } });
      if (!psn) throw new NotFoundException();
      if (psn.status !== "DISCREPANCY") {
        throw new ConflictException({
          message: `PSN in status ${psn.status} cannot be resolved as accepted; this action is only valid for DISCREPANCY.`,
          code: "psn_resolve_blocked",
        });
      }

      const updated = await tx.psn.update({
        where: { id: psnId },
        data: {
          status: "RECEIVED" as PsnStatus,
          // The PSN was already received once — keep that original
          // receivedAt timestamp intact so historical reports stay
          // accurate. We don't overwrite it with the resolution time.
          receivedAt: psn.receivedAt ?? new Date(),
        },
      });

      return { before: psn.status, updated };
    });

    await this.audit.log({
      actorId,
      action: "psn.discrepancy_resolved",
      resourceType: "psn",
      resourceId: psnId,
      beforeState: { status: result.before },
      afterState: {
        status: result.updated.status,
        resolutionNote: input.resolutionNote,
      },
    });

    return { psnId, status: result.updated.status };
  }

  /**
   * Initiate a customer return — the package ships back to the vendor's
   * address unopened. Vendor's wallet is debited for the return shipping
   * cost (estimate, since we may not have actuals yet).
   *
   * Allowed from any pre-receipt state, including HOLD (auto-conversion
   * after `release_after` lapse).
   */
  async requestReturn(
    psnId: string,
    actorId: string,
    input: { reason: string; returnShippingCents: number },
  ): Promise<{ psnId: string; status: PsnStatus }> {
    const RETURNABLE = ["AWAITING_RECEIPT", "PARTIALLY_RECEIVED", "DISCREPANCY", "HOLD"];

    return this.prisma.$transaction(async (tx) => {
      const psn = await tx.psn.findUnique({ where: { id: psnId } });
      if (!psn) throw new NotFoundException();
      if (!RETURNABLE.includes(psn.status)) {
        throw new ConflictException({
          message: `PSN in status ${psn.status} cannot be returned.`,
          code: "psn_return_blocked",
        });
      }

      // Debit the vendor's wallet for return shipping. If they're short on
      // funds, the debit throws and the whole transaction rolls back — admin
      // sees insufficient_funds and can cancel + escalate. Same pattern as
      // existing return.service / order.service code paths.
      if (input.returnShippingCents > 0) {
        await this.wallet.debit(
          {
            vendorId: psn.vendorId,
            amountCents: input.returnShippingCents,
            type: "SHIPPING",
            description: `Return shipping for PSN ${psn.id.slice(0, 8)}`,
            referenceType: "psn",
            referenceId: psn.id,
            actorId,
          },
          tx as unknown as Parameters<typeof this.wallet.debit>[1],
        );
      }

      // Mark any active hold as AUTO_RETURNED — the hold cycle ended in a
      // return rather than payment.
      await (
        tx as unknown as {
          psnHold: { updateMany: (a: unknown) => Promise<{ count: number }> };
        }
      ).psnHold.updateMany({
        where: { psnId, status: "PENDING_PAYMENT" },
        data: { status: "AUTO_RETURNED" },
      });

      const updated = await tx.psn.update({
        where: { id: psnId },
        data: {
          status: "RETURN_REQUESTED" as PsnStatus,
          returnRequestedReason: input.reason,
          returnRequestedAt: new Date(),
          returnShippingCents: input.returnShippingCents,
        } as unknown as Prisma.PsnUpdateInput,
      });

      await this.audit.log({
        actorId,
        action: "psn.return_requested",
        resourceType: "psn",
        resourceId: psnId,
        beforeState: { status: psn.status },
        afterState: {
          status: updated.status,
          reason: input.reason,
          returnShippingCents: input.returnShippingCents,
        },
      });

      return { psnId, status: updated.status };
    });
  }

  /**
   * Vendor pays the pending hold. Debits the wallet for the hold amount,
   * transitions the hold to PAID, and flips the PSN back to AWAITING_RECEIPT
   * so admin can resume the receive flow.
   *
   * Note: this method is called from a VENDOR-scoped endpoint (the vendor
   * paying their own hold), not from the admin controller. It still lives
   * here because the transaction touches the admin-side hold record + PSN
   * status, and centralising the logic keeps the invariants in one place.
   *
   * If wallet has insufficient funds, wallet.debit throws — the entire
   * transaction rolls back, no hold changes, no inventory changes.
   */
  async payHold(
    psnId: string,
    actorVendorId: string,
    actorUserId: string,
  ): Promise<{ psnId: string; holdId: string; status: PsnStatus }> {
    return this.prisma.$transaction(async (tx) => {
      const psn = await tx.psn.findUnique({ where: { id: psnId } });
      if (!psn) throw new NotFoundException();
      // Tenant scoping — the vendor can only pay their own holds.
      if (psn.vendorId !== actorVendorId) {
        throw new NotFoundException();
      }
      // Cast to string for the comparison — the generated Prisma client may
      // not yet include "HOLD" in PsnStatus until `prisma generate` is re-run
      // after migration 0020. At runtime the value is a literal Postgres
      // enum string. Same pattern used elsewhere in this file.
      if ((psn.status as string) !== "HOLD") {
        throw new ConflictException({
          message: `PSN is in status ${psn.status}, not HOLD — no payment due.`,
          code: "psn_no_hold",
        });
      }

      const hold = (await (
        tx as unknown as {
          psnHold: {
            findFirst: (a: unknown) => Promise<{
              id: string;
              extraChargeCents: number;
              status: string;
            } | null>;
          };
        }
      ).psnHold.findFirst({
        where: { psnId, status: "PENDING_PAYMENT" },
      })) as { id: string; extraChargeCents: number; status: string } | null;

      if (!hold) {
        throw new ConflictException({
          message: "No active hold found for this PSN.",
          code: "psn_hold_missing",
        });
      }

      // Debit. wallet.debit handles insufficient-funds itself; we let that
      // exception bubble up — frontend renders the topup CTA.
      // Cast on the type field — the generated DebitArgs union may not yet
      // include RECEIVING_HOLD_FEE until `prisma generate` runs after
      // migration 0019. At runtime the value is the literal enum string.
      const debitResult = await this.wallet.debit(
        {
          vendorId: psn.vendorId,
          amountCents: hold.extraChargeCents,
          type: "RECEIVING_HOLD_FEE" as "ONBOARDING",
          description: `Receiving hold release: PSN ${psn.id.slice(0, 8)}`,
          referenceType: "psn_hold",
          referenceId: hold.id,
          actorId: actorUserId,
        },
        tx as unknown as Parameters<typeof this.wallet.debit>[1],
      );

      await (
        tx as unknown as {
          psnHold: {
            update: (a: unknown) => Promise<unknown>;
          };
        }
      ).psnHold.update({
        where: { id: hold.id },
        data: {
          status: "PAID",
          paidAt: new Date(),
          ledgerEntryId: debitResult.entry.id,
        },
      });

      const updated = await tx.psn.update({
        where: { id: psnId },
        data: { status: "AWAITING_RECEIPT" as PsnStatus },
      });

      await this.audit.log({
        actorId: actorUserId,
        action: "psn.hold.paid",
        resourceType: "psn",
        resourceId: psnId,
        beforeState: { status: "HOLD" },
        afterState: {
          status: updated.status,
          holdId: hold.id,
          chargedCents: hold.extraChargeCents,
        },
      });

      return { psnId, holdId: hold.id, status: updated.status };
    });
  }
}
