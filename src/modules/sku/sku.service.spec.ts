/**
 * Date arithmetic for the 30-day rolling storage billing cycle.
 *
 * `computeFirstBillingDate` and `advanceBillingDate` are the only
 * places that own the per-SKU date math. Both the receive flow
 * (SkuService.receiveIntoBucket) and the daily cron
 * (StorageBillingJob.run) call into them, so any drift between the
 * two surfaces as a real billing bug. These tests pin the exact
 * arithmetic including month-end and year-end rollover edges that
 * are easy to get wrong with mutating Date setters.
 */

import { advanceBillingDate, computeFirstBillingDate } from "./sku.service";

describe("computeFirstBillingDate — 30 days after receipt", () => {
  // Contract: the returned date is exactly 30 calendar days after the
  // receipt date, at UTC midnight. The receiving fee paid at intake
  // covers the first 30 days, so the daily cron starts billing this
  // SKU the day `today >= computeFirstBillingDate(receivedAt)`.

  it("receive mid-month → 30 days later", () => {
    const received = new Date("2026-05-15T14:30:00Z");
    expect(computeFirstBillingDate(received).toISOString()).toBe("2026-06-14T00:00:00.000Z");
  });

  it("receive on day 1 of the month → last day of the same month", () => {
    const received = new Date("2026-05-01T00:01:00Z");
    expect(computeFirstBillingDate(received).toISOString()).toBe("2026-05-31T00:00:00.000Z");
  });

  it("receive late in the month → following month, 30 days later", () => {
    const received = new Date("2026-05-25T14:30:00Z");
    expect(computeFirstBillingDate(received).toISOString()).toBe("2026-06-24T00:00:00.000Z");
  });

  it("receive on Dec 31 → Jan 30 of the following year (year rollover)", () => {
    const received = new Date("2026-12-31T23:59:00Z");
    expect(computeFirstBillingDate(received).toISOString()).toBe("2027-01-30T00:00:00.000Z");
  });

  it("receive on Jan 31 in a non-leap year → Mar 2 (28 + 2)", () => {
    // 2027 is non-leap. Jan 31 + 30 days lands in March because
    // February only contributes 28 days.
    const received = new Date("2027-01-31T10:00:00Z");
    expect(computeFirstBillingDate(received).toISOString()).toBe("2027-03-02T00:00:00.000Z");
  });

  it("receive on Jan 31 in a leap year → Mar 1 (Feb has the extra day)", () => {
    // 2028 is a leap year. Jan 31 + 30 = Mar 1 because Feb 29 absorbs
    // one extra day of the rollover.
    const received = new Date("2028-01-31T10:00:00Z");
    expect(computeFirstBillingDate(received).toISOString()).toBe("2028-03-01T00:00:00.000Z");
  });

  it("ignores time-of-day — only the calendar day matters", () => {
    const earlyMorning = new Date("2026-05-15T00:00:00Z");
    const lateNight = new Date("2026-05-15T23:59:59Z");
    expect(computeFirstBillingDate(earlyMorning).toISOString()).toBe(
      computeFirstBillingDate(lateNight).toISOString(),
    );
  });

  it("returns a Date anchored at UTC midnight (time component zeroed)", () => {
    const received = new Date("2026-05-15T14:30:45.123Z");
    const out = computeFirstBillingDate(received);
    expect(out.getUTCHours()).toBe(0);
    expect(out.getUTCMinutes()).toBe(0);
    expect(out.getUTCSeconds()).toBe(0);
    expect(out.getUTCMilliseconds()).toBe(0);
  });
});

describe("advanceBillingDate — cron bumps date forward by one 30-day cycle", () => {
  // After each successful daily-cron debit the SKU's nextBillingDate
  // advances by exactly 30 days from its CURRENT value (not from
  // today). Same arithmetic as computeFirstBillingDate so the two
  // functions cannot drift.

  it("simple case: a date + 30 days", () => {
    const current = new Date("2026-06-14T00:00:00Z");
    expect(advanceBillingDate(current).toISOString()).toBe("2026-07-14T00:00:00.000Z");
  });

  it("rolls into the next month correctly", () => {
    const current = new Date("2026-07-15T00:00:00Z");
    expect(advanceBillingDate(current).toISOString()).toBe("2026-08-14T00:00:00.000Z");
  });

  it("December → January of the following year (year rollover)", () => {
    const current = new Date("2026-12-15T00:00:00Z");
    expect(advanceBillingDate(current).toISOString()).toBe("2027-01-14T00:00:00.000Z");
  });

  it("February in a non-leap year (Feb 28 + 30 = Mar 30)", () => {
    const current = new Date("2027-02-28T00:00:00Z");
    expect(advanceBillingDate(current).toISOString()).toBe("2027-03-30T00:00:00.000Z");
  });

  it("composes with computeFirstBillingDate — chain of three cycles", () => {
    // Receive May 25; the receiving fee covers day 1–30, so the cron
    // first bills on Jun 24 and then once every 30 days after:
    //   first         = computeFirstBillingDate(May 25) = Jun 24
    //   after cycle 1 = advanceBillingDate(Jun 24)       = Jul 24
    //   after cycle 2 = advanceBillingDate(Jul 24)       = Aug 23
    //   after cycle 3 = advanceBillingDate(Aug 23)       = Sep 22
    const received = new Date("2026-05-25T14:30:00Z");
    let date = computeFirstBillingDate(received);
    expect(date.toISOString()).toBe("2026-06-24T00:00:00.000Z");
    date = advanceBillingDate(date);
    expect(date.toISOString()).toBe("2026-07-24T00:00:00.000Z");
    date = advanceBillingDate(date);
    expect(date.toISOString()).toBe("2026-08-23T00:00:00.000Z");
    date = advanceBillingDate(date);
    expect(date.toISOString()).toBe("2026-09-22T00:00:00.000Z");
  });
});
