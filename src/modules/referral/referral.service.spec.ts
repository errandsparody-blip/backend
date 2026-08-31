/**
 * ReferralService — reward + resolution logic.
 *
 * The persistence is raw SQL, so we mock $queryRaw/$executeRaw/$transaction
 * and assert the DECISIONS that matter for money:
 *   - resolveRefCode maps to a vendor referrer, an active campaign, or null.
 *   - rewardOnFirstPsn credits BOTH sides once for a vendor-to-vendor
 *     referral, skips an already-rewarded row (no double-pay), and pays
 *     nothing for a pure campaign signup (just qualifies it).
 */

import { ReferralService } from "./referral.service";

type Row = Record<string, unknown>;

function makeService(opts: {
  txReferralRow?: Row | null;
  vendorQueryRows?: Row[]; // sequenced returns for prisma.$queryRaw
}) {
  const txExec = jest.fn(async () => 0);
  const txQuery = jest.fn(async () => (opts.txReferralRow ? [opts.txReferralRow] : []));
  const tx = { $queryRaw: txQuery, $executeRaw: txExec };

  const prismaQuery = jest.fn();
  if (opts.vendorQueryRows) {
    for (const r of opts.vendorQueryRows) prismaQuery.mockResolvedValueOnce([r]);
  }
  prismaQuery.mockResolvedValue([{ business_name: "Acme", email: "a@b.com" }]);

  const prisma = {
    $queryRaw: prismaQuery,
    $executeRaw: jest.fn(async () => 0),
    $transaction: jest.fn(async (cb: (t: unknown) => Promise<unknown>) => cb(tx)),
  };
  const wallet = {
    credit: jest.fn(async () => ({ entry: { id: "entry-x" }, balanceAfterCents: 5000 })),
  };
  const notifications = { emit: jest.fn(async () => {}) };

  const svc = new ReferralService(prisma as never, wallet as never, notifications as never);
  return { svc, prisma, tx, txExec, wallet, notifications };
}

describe("ReferralService.resolveRefCode", () => {
  it("resolves a vendor referral code to a referrer", async () => {
    const { svc } = makeService({ vendorQueryRows: [{ id: "vendor-1" }] });
    const r = await svc.resolveRefCode("ADAEZE-AB12");
    expect(r?.referrerVendorId).toBe("vendor-1");
    expect(r?.campaignId).toBeNull();
  });

  it("resolves an active campaign code", async () => {
    // First query (vendor) returns empty, second (campaign) returns a row.
    const { svc } = makeService({ vendorQueryRows: [] as Row[] });
    // Re-wire: vendor lookup empty, campaign lookup hit.
    (svc as unknown as { prisma: { $queryRaw: jest.Mock } }).prisma.$queryRaw = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "camp-1", reward_cents: 5000 }]);
    const r = await svc.resolveRefCode("LAGOS-2026");
    expect(r?.campaignId).toBe("camp-1");
    expect(r?.referrerVendorId).toBeNull();
  });

  it("returns null for an unknown code", async () => {
    const { svc, prisma } = makeService({});
    prisma.$queryRaw.mockResolvedValue([]); // both lookups empty
    const r = await svc.resolveRefCode("NOPE");
    expect(r).toBeNull();
  });
});

describe("ReferralService.rewardOnFirstPsn", () => {
  it("credits BOTH sides $50 and marks REWARDED for a vendor-to-vendor referral", async () => {
    const { svc, wallet, txExec } = makeService({
      txReferralRow: {
        id: "ref-1",
        referrer_vendor_id: "vendor-referrer",
        status: "REGISTERED",
        reward_cents: 5000,
        rewarded_at: null,
      },
    });
    await svc.rewardOnFirstPsn("vendor-referee");

    expect(wallet.credit).toHaveBeenCalledTimes(2);
    const calls = wallet.credit.mock.calls as unknown as Array<[{ amountCents: number; type: string }]>;
    expect(calls.map((c) => c[0].amountCents)).toEqual([5000, 5000]);
    for (const c of calls) {
      expect(c[0].type).toBe("REFERRAL_BONUS");
    }
    // One of the UPDATE statements marks the row REWARDED.
    expect(txExec).toHaveBeenCalled();
  });

  it("does NOT pay again when the referral is already rewarded", async () => {
    const { svc, wallet } = makeService({
      txReferralRow: {
        id: "ref-1",
        referrer_vendor_id: "vendor-referrer",
        status: "REWARDED",
        reward_cents: 5000,
        rewarded_at: new Date(),
      },
    });
    await svc.rewardOnFirstPsn("vendor-referee");
    expect(wallet.credit).not.toHaveBeenCalled();
  });

  it("pays nothing for a pure campaign signup (no referrer) — just qualifies", async () => {
    const { svc, wallet, txExec } = makeService({
      txReferralRow: {
        id: "ref-1",
        referrer_vendor_id: null,
        status: "REGISTERED",
        reward_cents: 5000,
        rewarded_at: null,
      },
    });
    await svc.rewardOnFirstPsn("vendor-referee");
    expect(wallet.credit).not.toHaveBeenCalled();
    expect(txExec).toHaveBeenCalled(); // marked QUALIFIED
  });

  it("does nothing when the vendor was never referred", async () => {
    const { svc, wallet } = makeService({ txReferralRow: null });
    await svc.rewardOnFirstPsn("vendor-x");
    expect(wallet.credit).not.toHaveBeenCalled();
  });
});
