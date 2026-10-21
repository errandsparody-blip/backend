/**
 * Money — a currency-aware value object (UK expansion, Phase 0).
 *
 * Today money is a bare integer of minor units assumed to be USD cents. As we
 * add the UK region (GBP), the danger is silently adding/comparing amounts of
 * different currencies. `Money` makes that a compile/runtime impossibility: you
 * can only combine or compare amounts of the SAME currency; anything else
 * throws. Minor units (cents / pence) stay integers — only the currency label
 * differs (both USD and GBP are 2-decimal).
 *
 * This is introduced ahead of use: services keep working on raw ints for now;
 * later phases migrate the money paths (wallet debit/credit, fees) onto Money.
 */

export type Currency = "USD" | "GBP";

export const CURRENCY_SYMBOL: Record<Currency, string> = {
  USD: "$",
  GBP: "£",
};

/** Thrown when an operation mixes two different currencies. */
export class CurrencyMismatchError extends Error {
  constructor(a: Currency, b: Currency) {
    super(`Currency mismatch: cannot combine ${a} with ${b}.`);
    this.name = "CurrencyMismatchError";
  }
}

export class Money {
  private constructor(
    /** Integer minor units (cents for USD, pence for GBP). */
    readonly amountMinor: number,
    readonly currency: Currency,
  ) {}

  /** Construct from integer minor units. Rejects non-integer amounts. */
  static of(amountMinor: number, currency: Currency): Money {
    if (!Number.isInteger(amountMinor)) {
      throw new Error(`Money amount must be an integer in minor units, got ${amountMinor}.`);
    }
    return new Money(amountMinor, currency);
  }

  static zero(currency: Currency): Money {
    return new Money(0, currency);
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.amountMinor + other.amountMinor, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.amountMinor - other.amountMinor, this.currency);
  }

  /** <0 if this < other, 0 if equal, >0 if this > other. Same-currency only. */
  compare(other: Money): number {
    this.assertSameCurrency(other);
    return this.amountMinor - other.amountMinor;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.amountMinor === other.amountMinor;
  }

  isNegative(): boolean {
    return this.amountMinor < 0;
  }

  isZero(): boolean {
    return this.amountMinor === 0;
  }

  /** Human-readable, e.g. "$12.34" or "£12.34". */
  format(): string {
    const major = (this.amountMinor / 100).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    return `${CURRENCY_SYMBOL[this.currency]}${major}`;
  }
}
