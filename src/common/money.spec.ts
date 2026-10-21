import { CurrencyMismatchError, Money } from "./money";

describe("Money", () => {
  it("adds and subtracts same-currency amounts", () => {
    const a = Money.of(1000, "GBP");
    const b = Money.of(250, "GBP");
    expect(a.add(b).amountMinor).toBe(1250);
    expect(a.subtract(b).amountMinor).toBe(750);
    expect(a.add(b).currency).toBe("GBP");
  });

  it("refuses to combine different currencies", () => {
    const usd = Money.of(1000, "USD");
    const gbp = Money.of(1000, "GBP");
    expect(() => usd.add(gbp)).toThrow(CurrencyMismatchError);
    expect(() => usd.subtract(gbp)).toThrow(CurrencyMismatchError);
    expect(() => usd.compare(gbp)).toThrow(CurrencyMismatchError);
  });

  it("equals checks both amount and currency", () => {
    expect(Money.of(500, "USD").equals(Money.of(500, "USD"))).toBe(true);
    expect(Money.of(500, "USD").equals(Money.of(500, "GBP"))).toBe(false);
    expect(Money.of(500, "USD").equals(Money.of(501, "USD"))).toBe(false);
  });

  it("rejects non-integer minor units", () => {
    expect(() => Money.of(10.5, "USD")).toThrow();
  });

  it("formats with the right symbol", () => {
    expect(Money.of(132168, "GBP").format()).toBe("£1,321.68");
    expect(Money.of(1152, "USD").format()).toBe("$11.52");
  });

  it("compare orders amounts and flags sign", () => {
    expect(Money.of(100, "USD").compare(Money.of(200, "USD"))).toBeLessThan(0);
    expect(Money.of(-5, "USD").isNegative()).toBe(true);
    expect(Money.zero("GBP").isZero()).toBe(true);
  });
});
