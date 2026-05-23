/**
 * Date arithmetic for Model B recurring billing (migration 0034).
 *
 * `computeFirstBillingDate` and `advanceBillingDate` are the only places
 * that own the "skip the next cron / bump forward one month" rules. Both
 * the receive flow (SkuService.receiveIntoBucket) and the cron
 * (StorageBillingJob.run) call into them, so any drift between the two
 * surfaces as a real billing bug. These tests pin the exact day-arithmetic
 * including the month-end / year-end rollover edges that are easy to get
 * wrong with mutating Date setters.
 */

import { advanceBillingDate, computeFirstBillingDate } from "./sku.service";

describe("computeFirstBillingDate — first cron run after intake", () => {
  // The contract: returned date is the first day of the month AFTER NEXT,
  // in UTC. Receive in May → first billing on July 1. The cron on June 1
  // is deliberately skipped because the intake fee already covered that
  // cycle.

  it("receive mid-month → first of month-after-next", () => {
    const received = new Date("2026-05-25T14:30:00Z");
    expect(computeFirstBillingDate(received).toISOString()).toBe("2026-07-01T00:00:00.000Z");
  });

  it("receive on day 1 of the month → still month-after-next (not this month's cron)", () => {
    // Cron runs at 02:00 UTC on the 1st. A SKU created at 00:01 UTC on
    // the 1st would otherwise be eligible for the cron that runs an
    // hour later — that's the double-charge edge case we're explicitly
    // preventing.
    const received = new Date("2026-05-01T00:01:00Z");
    expect(computeFirstBillingDate(received).toISOString()).toBe("2026-07-01T00:00:00.000Z");
  });

  it("receive on last day of the month → month-after-next still rolls correctly", () => {
    const received = new Date("2026-05-31T23:59:00Z");
    expect(computeFirstBillingDate(received).toISOString()).toBe("2026-07-01T00:00:00.000Z");
  });

  it("December receive → February of the following year (year rollover)", () => {
    const received = new Date("2026-12-15T10:00:00Z");
    expect(computeFirstBillingDate(received).toISOString()).toBe("2027-02-01T00:00:00.000Z");
  });

  it("November receive → January of the following year (one-month rollover)", () => {
    const received = new Date("2026-11-22T10:00:00Z");
    expect(computeFirstBillingDate(received).toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });

  it("ignores time-of-day — only the month matters", () => {
    const earlyMorning = new Date("2026-05-15T00:00:00Z");
    const lateNight = new Date("2026-05-15T23:59:59Z");
    expect(computeFirstBillingDate(earlyMorning).toISOString()).toBe(
      computeFirstBillingDate(lateNight).toISOString(),
    );
  });
});

describe("advanceBillingDate — cron bumps date forward one month", () => {
  // After each successful storage debit the cron advances the SKU's
  // nextBillingDate to the next month's first. Same UTC anchoring as
  // computeFirstBillingDate so the two functions can't drift.

  it("first → first of next month", () => {
    const current = new Date("2026-07-01T00:00:00Z");
    expect(advanceBillingDate(current).toISOString()).toBe("2026-08-01T00:00:00.000Z");
  });

  it("handles month-end source dates (defensive — cron should always pass a 1st)", () => {
    const current = new Date("2026-07-31T00:00:00Z");
    expect(advanceBillingDate(current).toISOString()).toBe("2026-08-01T00:00:00.000Z");
  });

  it("December → January of the following year", () => {
    const current = new Date("2026-12-01T00:00:00Z");
    expect(advanceBillingDate(current).toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });

  it("composes with computeFirstBillingDate — chain of three cron runs", () => {
    // Receive May 25, then three cron runs (Jul 1, Aug 1, Sep 1):
    //   first         = computeFirstBillingDate(May 25) = Jul 1
    //   after run 1   = advanceBillingDate(Jul 1)       = Aug 1
    //   after run 2   = advanceBillingDate(Aug 1)       = Sep 1
    //   after run 3   = advanceBillingDate(Sep 1)       = Oct 1
    const received = new Date("2026-05-25T14:30:00Z");
    let date = computeFirstBillingDate(received);
    expect(date.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    date = advanceBillingDate(date);
    expect(date.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    date = advanceBillingDate(date);
    expect(date.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    date = advanceBillingDate(date);
    expect(date.toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });
});
