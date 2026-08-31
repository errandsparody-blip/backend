/**
 * WalletService — the most security-sensitive service in the platform.
 *
 * Implementation Plan §6.4, §14.2.
 *
 * Invariants enforced here AND at the DB level (migration 0005):
 *   - balance_cents >= 0 always
 *   - ledger_entries is append-only at DB privilege level
 *   - sum(ledger_entries.amount_cents) == wallets.balance_cents per vendor
 *
 * Every state-changing method runs inside a single Prisma transaction with
 * SELECT ... FOR UPDATE on the wallet row. Concurrent debits cannot overdraw.
 *
 * Two reviewers required for any change to this file (Implementation Plan §17.1).
 */

import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { LedgerEntry, LedgerEntryType, PrismaClient, Wallet } from "@prisma/client";

import { PrismaService } from "../../common/prisma.service";
import { AuditService } from "../audit/audit.service";
import { lowBalanceTemplate } from "../email/email-templates";
import { NotificationService } from "../notifications/notification.service";

type Tx = Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">;

export interface DebitArgs {
  vendorId: string;
  /** Always positive cents — the service applies the sign per type. */
  amountCents: number;
  type: Extract<
    LedgerEntryType,
    | "ONBOARDING"
    | "STORAGE"
    | "FULFILLMENT"
    | "SHIPPING"
    | "RETURN"
    | "MANUAL_DEBIT"
    // Migration 0019 / 0020 — Phase 2 receiving holds. Admin places a Hold
    // with an extra-charge amount; this debit fires when vendor's wallet
    // covers the charge and the hold transitions to PAID.
    | "RECEIVING_HOLD_FEE"
  >;
  description: string;
  referenceType?: string;
  referenceId?: string;
  idempotencyKey?: string;
  actorId?: string;
}

export interface CreditArgs {
  vendorId: string;
  amountCents: number;
  // REFUND added in migration 0019 — distinct from REVERSAL (which is for
  // order cancellations); REFUND is for explicit money-back-to-vendor.
  // REFERRAL_BONUS (migration 0056) is a string literal here rather than an
  // Extract<LedgerEntryType, …> so it typechecks before the local Prisma
  // client is regenerated with the new enum value; the write casts to the
  // enum, and the regenerated client (Railway) accepts it at runtime.
  type:
    | Extract<LedgerEntryType, "DEPOSIT" | "MANUAL_CREDIT" | "REVERSAL" | "REFUND">
    | "REFERRAL_BONUS";
  description: string;
  referenceType?: string;
  referenceId?: string;
  idempotencyKey?: string;
  actorId?: string;
}

export interface WalletSnapshot {
  id: string;
  vendorId: string;
  balanceCents: number;
  lowBalanceThresholdCents: number;
  status: Wallet["status"];
  updatedAt: Date;
}

@Injectable()
export class WalletService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
  ) {}

  // ---------------------------------------------------------------------------
  // Read
  // ---------------------------------------------------------------------------

  async get(vendorId: string): Promise<WalletSnapshot> {
    const w = await this.prisma.wallet.findUnique({ where: { vendorId } });
    if (!w) throw new NotFoundException("Wallet not found.");
    return this.toSnapshot(w);
  }

  /** Idempotent provisioning. Called from vendor signup. */
  async ensureWalletExists(vendorId: string, tx?: Tx): Promise<void> {
    const client = (tx ?? this.prisma) as PrismaClient;
    const existing = await client.wallet.findUnique({ where: { vendorId } });
    if (existing) return;
    await client.wallet.create({ data: { vendorId } });
  }

  // ---------------------------------------------------------------------------
  // Atomic debit / credit primitives
  // ---------------------------------------------------------------------------

  /**
   * Debit the wallet. Must be the ONLY way to subtract from balance.
   *
   * Atomic: SELECT ... FOR UPDATE on the wallet row, validate balance,
   * write ledger entry, update balance, all in one transaction. On
   * insufficient funds, throws and the transaction rolls back.
   *
   * Optionally accepts an outer transaction (`tx`) so a caller can compose
   * the debit with adjacent inventory or order writes. This is critical for
   * order fulfillment — the wallet debit and inventory reservation must
   * succeed or fail together (Implementation Plan §14.3).
   */
  async debit(args: DebitArgs, tx?: Tx): Promise<{ entry: LedgerEntry; balanceAfterCents: number }> {
    if (!Number.isInteger(args.amountCents) || args.amountCents <= 0) {
      throw new ConflictException({
        message: "Debit amount must be a positive integer (cents).",
        code: "wallet_invalid_amount",
      });
    }
    let crossedLowBalance = false;
    let lowBalanceThreshold = 0;

    const run = async (txc: Tx) => {
      const balance = await this.lockAndRead(txc, args.vendorId);
      if (balance < args.amountCents) {
        throw new ConflictException({
          message: `Insufficient funds. Balance is $${(balance / 100).toFixed(2)}.`,
          code: "insufficient_funds",
        });
      }
      const after = balance - args.amountCents;

      // Capture the threshold + check whether THIS debit is the one that
      // crosses below it. We only fire the alert once per crossing.
      const wallet = await txc.wallet.findUnique({
        where: { vendorId: args.vendorId },
        select: { lowBalanceThresholdCents: true },
      });
      lowBalanceThreshold = wallet?.lowBalanceThresholdCents ?? 0;
      crossedLowBalance =
        balance > lowBalanceThreshold && after <= lowBalanceThreshold && lowBalanceThreshold > 0;

      const entry = await txc.ledgerEntry.create({
        data: {
          vendorId: args.vendorId,
          type: args.type,
          // Charges stored as negative cents.
          amountCents: -args.amountCents,
          balanceAfterCents: after,
          description: args.description,
          referenceType: args.referenceType ?? null,
          referenceId: args.referenceId ?? null,
          idempotencyKey: args.idempotencyKey ?? null,
          createdBy: args.actorId ?? null,
        },
      });
      await txc.wallet.update({
        where: { vendorId: args.vendorId },
        data: { balanceCents: after },
      });
      return { entry, balanceAfterCents: after };
    };

    const result = tx ? await run(tx) : await this.prisma.$transaction(run);

    await this.audit.log({
      actorId: args.actorId ?? null,
      action: `wallet.debit.${args.type.toLowerCase()}`,
      resourceType: "wallet",
      resourceId: args.vendorId,
      afterState: {
        amountCents: args.amountCents,
        balanceAfterCents: result.balanceAfterCents,
        referenceType: args.referenceType ?? null,
        referenceId: args.referenceId ?? null,
      },
    });

    if (crossedLowBalance) {
      const vendor = await this.prisma.vendor.findUnique({
        where: { id: args.vendorId },
        select: { businessName: true },
      });
      const tpl = lowBalanceTemplate({
        businessName: vendor?.businessName ?? "Your account",
        balanceCents: result.balanceAfterCents,
        thresholdCents: lowBalanceThreshold,
      });
      await this.notifications.emit({
        vendorId: args.vendorId,
        type: "wallet.low_balance",
        severity: "WARNING",
        title: "Wallet balance is low",
        body: `Your balance is $${(result.balanceAfterCents / 100).toFixed(2)}, at or below your alert threshold of $${(lowBalanceThreshold / 100).toFixed(2)}. Add funds to keep fulfillments running.`,
        href: "/wallet/fund",
        email: { subject: tpl.subject, html: tpl.html, text: tpl.text },
      });
    }

    return result;
  }

  /**
   * Credit the wallet. Symmetric to debit. Used for deposits, manual credits,
   * reversals (chargebacks). Atomic and lock-protected.
   */
  async credit(args: CreditArgs, tx?: Tx): Promise<{ entry: LedgerEntry; balanceAfterCents: number }> {
    if (!Number.isInteger(args.amountCents) || args.amountCents <= 0) {
      throw new ConflictException({
        message: "Credit amount must be a positive integer (cents).",
        code: "wallet_invalid_amount",
      });
    }
    const run = async (txc: Tx) => {
      const balance = await this.lockAndRead(txc, args.vendorId);
      const after = balance + args.amountCents;
      const entry = await txc.ledgerEntry.create({
        data: {
          vendorId: args.vendorId,
          // Cast: REFERRAL_BONUS may not be in the local (stale) generated
          // enum yet; the DB + regenerated client accept it.
          type: args.type as LedgerEntryType,
          amountCents: args.amountCents,
          balanceAfterCents: after,
          description: args.description,
          referenceType: args.referenceType ?? null,
          referenceId: args.referenceId ?? null,
          idempotencyKey: args.idempotencyKey ?? null,
          createdBy: args.actorId ?? null,
        },
      });
      await txc.wallet.update({
        where: { vendorId: args.vendorId },
        data: { balanceCents: after },
      });
      return { entry, balanceAfterCents: after };
    };

    const result = tx ? await run(tx) : await this.prisma.$transaction(run);

    await this.audit.log({
      actorId: args.actorId ?? null,
      action: `wallet.credit.${args.type.toLowerCase()}`,
      resourceType: "wallet",
      resourceId: args.vendorId,
      afterState: {
        amountCents: args.amountCents,
        balanceAfterCents: result.balanceAfterCents,
        referenceType: args.referenceType ?? null,
        referenceId: args.referenceId ?? null,
      },
    });
    return result;
  }

  // ---------------------------------------------------------------------------
  // Reconciliation — proves the materialized balance equals the ledger sum.
  // The daily reconciliation job (P2.7) calls this for every vendor.
  // ---------------------------------------------------------------------------

  async reconcile(vendorId: string): Promise<{ ok: boolean; materialized: number; ledger: number }> {
    const wallet = await this.prisma.wallet.findUnique({ where: { vendorId } });
    if (!wallet) throw new NotFoundException();
    const sum = await this.prisma.ledgerEntry.aggregate({
      where: { vendorId },
      _sum: { amountCents: true },
    });
    const ledger = sum._sum.amountCents ?? 0;
    const ok = ledger === wallet.balanceCents;

    // Security audit L-3 — write a permanent audit row whenever the
    // materialized balance diverges from the ledger sum. Previously
    // the cron only logged the warning via pino, which can be rotated
    // out or sampled by Sentry — meaning a brief corruption event
    // could resolve before anyone investigates and leave no trail.
    // Now finance can SELECT FROM audit_logs WHERE action = '...' and
    // see every reconciliation failure in chronological order.
    if (!ok) {
      await this.audit
        .log({
          action: "wallet.reconciliation.mismatch",
          resourceType: "wallet",
          resourceId: wallet.id,
          onBehalfOfVendorId: vendorId,
          beforeState: { materializedCents: wallet.balanceCents },
          afterState: {
            ledgerSumCents: ledger,
            divergenceCents: ledger - wallet.balanceCents,
          },
        })
        .catch(() => undefined);
    }
    return { ok, materialized: wallet.balanceCents, ledger };
  }

  // ---------------------------------------------------------------------------

  /**
   * Lock the wallet row for the duration of the transaction and return the
   * current balance. This is the linchpin of atomicity — without FOR UPDATE,
   * two concurrent debits could each see the same balance and both succeed.
   *
   * Postgres-specific. Prisma's $queryRaw is the only way to issue
   * `SELECT ... FOR UPDATE` from the typed client.
   */
  private async lockAndRead(tx: Tx, vendorId: string): Promise<number> {
    const rows = await tx.$queryRaw<Array<{ balance_cents: number }>>(
      Prisma.sql`SELECT balance_cents FROM wallets WHERE vendor_id = ${vendorId}::uuid FOR UPDATE`,
    );
    const row = rows[0];
    if (!row) throw new NotFoundException("Wallet not found.");
    return row.balance_cents;
  }

  private toSnapshot(w: Wallet): WalletSnapshot {
    return {
      id: w.id,
      vendorId: w.vendorId,
      balanceCents: w.balanceCents,
      lowBalanceThresholdCents: w.lowBalanceThresholdCents,
      status: w.status,
      updatedAt: w.updatedAt,
    };
  }
}
