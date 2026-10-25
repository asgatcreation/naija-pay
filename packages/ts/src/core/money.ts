/**
 * Money.
 *
 * An amount is an integer in the currency's minor unit — kobo for naira — and never a
 * float. This is not stylistic fussiness. Korapay's own PHP webhook sample has to set
 * `serialize_precision = -1` so that re-encoding an amount does not change it, which
 * is what a float round-trip inside a signature check looks like in production.
 *
 * Splits use integer arithmetic throughout, and the rounding remainder goes somewhere
 * explicit rather than evaporating.
 */

/** Currencies the Tier 1 providers document support for. */
export type Currency = "NGN" | "GHS" | "KES" | "ZAR" | "USD" | "XOF";

/**
 * How many minor units make one major unit.
 *
 * XOF is the odd one out: it has no subunit, but Paystack documents that amounts are
 * still multiplied by 100 and that any fractional part is dropped during processing.
 * We therefore treat it as exponent 2 like the others, and `fromMajor` refuses a
 * fractional XOF amount rather than letting the provider silently discard it.
 */
const MINOR_UNIT_EXPONENT: Record<Currency, number> = {
  NGN: 2,
  GHS: 2,
  KES: 2,
  ZAR: 2,
  USD: 2,
  XOF: 2,
};

/** XOF has no real subunit, so a fractional major amount is meaningless. */
const CURRENCIES_WITHOUT_SUBUNIT: ReadonlySet<Currency> = new Set<Currency>(["XOF"]);

export interface Money {
  /** Integer count of minor units. Never a float, never negative. */
  readonly amount: number;
  readonly currency: Currency;
}

export class MoneyError extends Error {
  override readonly name = "MoneyError";
}

function assertValidAmount(amount: number, currency: string): void {
  if (typeof amount !== "number" || Number.isNaN(amount)) {
    throw new MoneyError(`amount must be a number, received ${String(amount)}`);
  }
  if (!Number.isFinite(amount)) {
    throw new MoneyError("amount must be finite");
  }
  if (!Number.isInteger(amount)) {
    throw new MoneyError(
      `amount must be an integer number of minor units, received ${amount}. ` +
        `For ${currency}, 1.50 is 150, not 1.5`,
    );
  }
  if (amount < 0) {
    throw new MoneyError(`amount must not be negative, received ${amount}`);
  }
  if (!Number.isSafeInteger(amount)) {
    throw new MoneyError(`amount ${amount} exceeds the safe integer range`);
  }
}

function assertKnownCurrency(currency: string): asserts currency is Currency {
  if (!(currency in MINOR_UNIT_EXPONENT)) {
    throw new MoneyError(
      `unknown currency "${currency}"; supported: ${Object.keys(MINOR_UNIT_EXPONENT).join(", ")}`,
    );
  }
}

/** Construct an amount from a count of minor units (kobo, cents, pesewas). */
export function money(amount: number, currency: Currency): Money {
  assertKnownCurrency(currency);
  assertValidAmount(amount, currency);
  return Object.freeze({ amount, currency });
}

/** Naira to kobo. `naira(150)` is 15000 kobo. */
export function naira(majorUnits: number): Money {
  return fromMajor(majorUnits, "NGN");
}

/**
 * Convert a major-unit amount (150.75 naira) into Money (15075 kobo).
 *
 * Takes a float only at this boundary, and refuses anything with more decimal places
 * than the currency actually has, rather than rounding it away behind the caller's
 * back. Multiplication is done on a rounded integer to avoid the classic
 * `1.15 * 100 === 114.99999999999999`.
 */
export function fromMajor(majorUnits: number, currency: Currency): Money {
  assertKnownCurrency(currency);
  if (typeof majorUnits !== "number" || !Number.isFinite(majorUnits)) {
    throw new MoneyError(`major amount must be a finite number, received ${String(majorUnits)}`);
  }
  if (CURRENCIES_WITHOUT_SUBUNIT.has(currency) && !Number.isInteger(majorUnits)) {
    throw new MoneyError(
      `${currency} has no subunit, so ${majorUnits} cannot be represented. ` +
        `Providers drop the fractional part during processing, so naija-pay refuses it here instead`,
    );
  }

  const exponent = MINOR_UNIT_EXPONENT[currency];
  const factor = 10 ** exponent;
  const scaled = Math.round(majorUnits * factor);

  if (Math.abs(scaled / factor - majorUnits) > Number.EPSILON * Math.abs(majorUnits)) {
    throw new MoneyError(
      `${majorUnits} ${currency} has more precision than ${currency} supports ` +
        `(${exponent} decimal places)`,
    );
  }
  return money(scaled, currency);
}

/** The minor-unit exponent for a currency, e.g. 2 for NGN. */
export function minorUnitExponent(currency: Currency): number {
  assertKnownCurrency(currency);
  return MINOR_UNIT_EXPONENT[currency];
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new MoneyError(`cannot combine ${a.currency} and ${b.currency}`);
  }
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amount + b.amount, a.currency);
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  if (b.amount > a.amount) {
    throw new MoneyError(
      `subtracting ${b.amount} from ${a.amount} would produce a negative amount`,
    );
  }
  return money(a.amount - b.amount, a.currency);
}

export function isZero(m: Money): boolean {
  return m.amount === 0;
}

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  return a.amount < b.amount ? -1 : a.amount > b.amount ? 1 : 0;
}

export function equals(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.amount === b.amount;
}

/** Formats for humans: `money(15075, "NGN")` becomes `"NGN 150.75"`. */
export function format(m: Money): string {
  const exponent = MINOR_UNIT_EXPONENT[m.currency];
  if (exponent === 0) return `${m.currency} ${m.amount}`;
  const factor = 10 ** exponent;
  const major = Math.floor(m.amount / factor);
  const minor = String(m.amount % factor).padStart(exponent, "0");
  return `${m.currency} ${major}.${minor}`;
}

/** Basis points: 10000 bps is 100%. Integers only, so no float percentages. */
export const BASIS_POINTS_TOTAL = 10_000;

export interface Share {
  /** Opaque identifier for whoever receives this share. */
  readonly account: string;
  /** Portion in basis points for a percentage split, or minor units for a flat one. */
  readonly share: number;
}

export interface SplitPart {
  readonly account: string;
  readonly amount: Money;
}

export interface SplitResult {
  readonly parts: readonly SplitPart[];
  /**
   * What is left for the main account after every share: the residue plus the
   * rounding remainder. Integer division cannot divide every amount evenly, and the
   * leftover kobo has to belong to someone — it is never dropped.
   */
  readonly remainder: Money;
}

/**
 * Split an amount by basis-point shares.
 *
 * Each share is floored, and every leftover minor unit lands in `remainder`, so the
 * parts plus the remainder always sum exactly to the input. Property tests assert
 * that for arbitrary amounts and share sets.
 */
export function splitByBasisPoints(total: Money, shares: readonly Share[]): SplitResult {
  let totalBps = 0;
  for (const s of shares) {
    if (!Number.isInteger(s.share) || s.share < 0) {
      throw new MoneyError(
        `share for "${s.account}" must be a non-negative integer number of basis points, ` +
          `received ${s.share}`,
      );
    }
    totalBps += s.share;
  }
  if (totalBps > BASIS_POINTS_TOTAL) {
    throw new MoneyError(
      `shares total ${totalBps} basis points, which is more than 100% (${BASIS_POINTS_TOTAL})`,
    );
  }

  const parts: SplitPart[] = [];
  let allocated = 0;
  for (const s of shares) {
    // Floor division on integers: no float ever enters the calculation.
    const amount = Math.floor((total.amount * s.share) / BASIS_POINTS_TOTAL);
    allocated += amount;
    parts.push({ account: s.account, amount: money(amount, total.currency) });
  }

  return Object.freeze({
    parts: Object.freeze(parts),
    remainder: money(total.amount - allocated, total.currency),
  });
}

/**
 * Split by flat amounts, each already in minor units.
 *
 * Fails if the flat amounts exceed the total, because a split that pays out more than
 * came in is always a bug and must never reach a provider.
 */
export function splitByFlatAmounts(total: Money, shares: readonly Share[]): SplitResult {
  const parts: SplitPart[] = [];
  let allocated = 0;
  for (const s of shares) {
    const part = money(s.share, total.currency);
    allocated += part.amount;
    parts.push({ account: s.account, amount: part });
  }
  if (allocated > total.amount) {
    throw new MoneyError(
      `flat shares total ${allocated} ${total.currency} minor units, ` +
        `which is more than the ${total.amount} being split`,
    );
  }
  return Object.freeze({
    parts: Object.freeze(parts),
    remainder: money(total.amount - allocated, total.currency),
  });
}
