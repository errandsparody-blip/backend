/**
 * WalletService — security-critical invariants.
 *
 *   1. Insufficient funds → ConflictException, no ledger entry, balance unchanged.
 *   2. Sign convention: charges stored as negative cents; deposits positive.
 *   3. Reconciliation: sum(ledger) === wallet.balance after every operation.
 *   4. Audit log fires on every successful debit and credit.
 *   5. Invalid amount (zero / negative / non-integer) is rejected.
 */

import { ConflictException, NotFoundException } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";

import { PrismaService } from "../../common/prisma.service";
import { AuditService } from "../audit/audit.service";
import { NotificationService } from "../notifications/notification.service";

import { WalletService } from "./wallet.service";

interface WalletRow {
  id: string;
  vendorId: string;
  balanceCents: number;
  lowBalanceThresholdCents: number;
  status: "ACTIVE" | "STORAGE_OVERDUE" | "SUSPENDED" | "CLOSED";
  createdAt: Date;
  updatedAt: Date;
}

interface LedgerRow {
  id: string;
  vendorId: string;
  type: string;
  amountCents: number;
  balanceAfterCents: number;
  description: string;
  referenceType: string | null;
  referenceId: string | null;
  idempotencyKey: string | null;
  createdBy: string | null;
  createdAt: Date;
}

/**
 * In-memory PrismaService double. Mimics the slice of Prisma the service
 * touches, including FOR UPDATE — we just resolve via the in-memory row.
 */
class FakePrisma {
  wallets: WalletRow[] = [];
  ledger: LedgerRow[] = [];
  nextId = 1;

  wallet = {
    findUnique: async ({ where }: { where: { vendorId: string } }) =>
      this.wallets.find((w) => w.vendorId === where.vendorId) ?? null,
    create: async ({ data }: { data: { vendorId: string; balanceCents?: number } }) => {
      const w: WalletRow = {
        id: `w${this.nextId++}`,
        vendorId: data.vendorId,
        balanceCents: data.balanceCents ?? 0,
        lowBalanceThresholdCents: 5000,
        status: "ACTIVE",
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      this.wallets.push(w);
      return w;
    },
    update: async ({ where, data }: { where: { vendorId: string }; data: Partial<WalletRow> }) => {
      const w = this.wallets.find((x) => x.vendorId === where.vendorId);
      if (!w) throw new Error("not found");
      Object.assign(w, data, { updatedAt: new Date() });
      return w;
    },
  };

  ledgerEntry = {
    create: async ({ data }: { data: Omit<LedgerRow, "id" | "createdAt"> }) => {
      const row: LedgerRow = { id: `e${this.nextId++}`, createdAt: new Date(), ...data };
      this.ledger.push(row);
      return row;
    },
    aggregate: async ({ where }: { where: { vendorId: string } }) => ({
      _sum: {
        amountCents: this.ledger
          .filter((e) => e.vendorId === where.vendorId)
          .reduce((s, e) => s + e.amountCents, 0),
      },
    }),
  };

  /**
   * Fake $queryRaw — returns the wallet's balance to mimic the FOR UPDATE call.
   *
   * Two invocation shapes are possible:
   *   1) Tagged template:  prisma.$queryRaw`SELECT ... ${vendorId}`
   *      → invoked as  fn(strings: TemplateStringsArray, ...values)
   *   2) Prisma.sql arg:   prisma.$queryRaw(Prisma.sql`SELECT ... ${vendorId}`)
   *      → invoked as  fn(sql: Prisma.Sql) where sql.values is the param array
   *
   * The service uses (2). Older callers may use (1). Handle both so this fake
   * is reusable.
   */
  $queryRaw = async <T>(arg: unknown, ...rest: unknown[]): Promise<T> => {
    let vendorId: string | undefined;
    if (arg && typeof arg === "object" && "values" in arg && Array.isArray((arg as { values: unknown[] }).values)) {
      vendorId = (arg as { values: unknown[] }).values[0] as string;
    } else {
      vendorId = rest[0] as string;
    }
    const w = this.wallets.find((x) => x.vendorId === vendorId);
    if (!w) return [] as T;
    return [{ balance_cents: w.balanceCents }] as T;
  };

  // Make $transaction inline — pass `this` through as the tx client.
  $transaction = async <T>(cb: (tx: FakePrisma) => Promise<T>): Promise<T> => cb(this);
}

describe("WalletService", () => {
  let svc: WalletService;
  let prisma: FakePrisma;
  let audit: { log: jest.Mock };
  let notifications: { emit: jest.Mock };

  const VENDOR = "v-1";

  beforeEach(async () => {
    prisma = new FakePrisma();
    audit = { log: jest.fn() };
    // The service emits a low-balance notification when a debit crosses
    // the alert threshold. None of the cases in this spec cross the threshold,
    // but the constructor still requires the dependency.
    notifications = { emit: jest.fn() };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        WalletService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
        { provide: NotificationService, useValue: notifications },
      ],
    }).compile();
    svc = moduleRef.get(WalletService);
  });

  // -------------------------------------------------------------------------
  // Bootstrapping
  // -------------------------------------------------------------------------
  it("ensureWalletExists creates one wallet then is a no-op on replay", async () => {
    await svc.ensureWalletExists(VENDOR);
    await svc.ensureWalletExists(VENDOR);
    expect(prisma.wallets).toHaveLength(1);
  });

  it("get throws NotFound when no wallet exists", async () => {
    await expect(svc.get("ghost")).rejects.toBeInstanceOf(NotFoundException);
  });

  // -------------------------------------------------------------------------
  // Credit
  // -------------------------------------------------------------------------
  it("credit increases balance, stores positive amount, writes audit log", async () => {
    await svc.ensureWalletExists(VENDOR);
    const r = await svc.credit({
      vendorId: VENDOR,
      amountCents: 50000,
      type: "DEPOSIT",
      description: "Stripe deposit",
    });
    expect(r.balanceAfterCents).toBe(50000);
    expect(prisma.ledger).toHaveLength(1);
    expect(prisma.ledger[0]!.amountCents).toBe(50000);
    expect(prisma.wallets[0]!.balanceCents).toBe(50000);
    expect(audit.log).toHaveBeenCalledTimes(1);
  });

  it("rejects zero / negative / non-integer amounts on credit", async () => {
    await svc.ensureWalletExists(VENDOR);
    await expect(
      svc.credit({ vendorId: VENDOR, amountCents: 0, type: "DEPOSIT", description: "x" }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      svc.credit({ vendorId: VENDOR, amountCents: -50, type: "DEPOSIT", description: "x" }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      svc.credit({ vendorId: VENDOR, amountCents: 1.5, type: "DEPOSIT", description: "x" }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  // -------------------------------------------------------------------------
  // Debit
  // -------------------------------------------------------------------------
  it("debit decreases balance and stores negative amount", async () => {
    prisma.wallets.push({
      id: "w0",
      vendorId: VENDOR,
      balanceCents: 10_000,
      lowBalanceThresholdCents: 5000,
      status: "ACTIVE",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const r = await svc.debit({
      vendorId: VENDOR,
      amountCents: 2_500,
      type: "ONBOARDING",
      description: "PSN onboarding",
      referenceType: "psn",
      referenceId: "p1",
    });
    expect(r.balanceAfterCents).toBe(7_500);
    expect(prisma.ledger[0]!.amountCents).toBe(-2_500);
    expect(prisma.ledger[0]!.type).toBe("ONBOARDING");
    expect(prisma.wallets[0]!.balanceCents).toBe(7_500);
  });

  it("insufficient funds → ConflictException, NO ledger entry, balance unchanged", async () => {
    prisma.wallets.push({
      id: "w0",
      vendorId: VENDOR,
      balanceCents: 1_000,
      lowBalanceThresholdCents: 5000,
      status: "ACTIVE",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const e = await svc
      .debit({ vendorId: VENDOR, amountCents: 5_000, type: "ONBOARDING", description: "PSN" })
      .catch((err) => err as ConflictException);
    expect(e).toBeInstanceOf(ConflictException);
    expect((e as ConflictException).getResponse()).toMatchObject({ code: "insufficient_funds" });
    // CRITICAL: no ledger row written.
    expect(prisma.ledger).toHaveLength(0);
    // Balance untouched.
    expect(prisma.wallets[0]!.balanceCents).toBe(1_000);
    // No audit either — refused operations don't leave a trail through the audit channel.
    expect(audit.log).toHaveBeenCalledTimes(0);
  });

  // -------------------------------------------------------------------------
  // Reconciliation invariant
  // -------------------------------------------------------------------------
  it("sum(ledger) === wallet.balance after a sequence of credits and debits", async () => {
    await svc.ensureWalletExists(VENDOR);
    await svc.credit({ vendorId: VENDOR, amountCents: 100_000, type: "DEPOSIT", description: "fund" });
    await svc.debit({ vendorId: VENDOR, amountCents: 25_000, type: "ONBOARDING", description: "psn" });
    await svc.debit({ vendorId: VENDOR, amountCents: 1_500, type: "STORAGE", description: "monthly" });
    await svc.credit({ vendorId: VENDOR, amountCents: 5_000, type: "MANUAL_CREDIT", description: "support" });

    const recon = await svc.reconcile(VENDOR);
    expect(recon.ok).toBe(true);
    expect(recon.materialized).toBe(78_500);
    expect(recon.ledger).toBe(78_500);
  });

  it("balance_after_cents on each ledger entry forms a continuous trail", async () => {
    await svc.ensureWalletExists(VENDOR);
    await svc.credit({ vendorId: VENDOR, amountCents: 10_000, type: "DEPOSIT", description: "1" });
    await svc.debit({ vendorId: VENDOR, amountCents: 3_000, type: "ONBOARDING", description: "2" });
    await svc.credit({ vendorId: VENDOR, amountCents: 2_000, type: "DEPOSIT", description: "3" });

    const after = prisma.ledger.map((e) => e.balanceAfterCents);
    expect(after).toEqual([10_000, 7_000, 9_000]);
  });
});
