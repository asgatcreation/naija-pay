import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  add,
  BASIS_POINTS_TOTAL,
  basisPointsToFraction,
  compare,
  equals,
  format,
  fromMajor,
  MoneyError,
  money,
  naira,
  splitByBasisPoints,
  splitByFlatAmounts,
  subtract,
  toMajor,
} from "../src/core/money.ts";

describe("money construction", () => {
  test("takes an integer count of minor units", () => {
    assert.deepEqual(money(15_000, "NGN"), { amount: 15_000, currency: "NGN" });
  });

  test("naira() converts major units to kobo", () => {
    assert.equal(naira(150).amount, 15_000);
    assert.equal(naira(0).amount, 0);
  });

  test("rejects a float amount, with a message that explains the unit", () => {
    assert.throws(
      () => money(1.5, "NGN"),
      (e: unknown) => {
        assert.ok(e instanceof MoneyError);
        assert.match((e as Error).message, /must be an integer/);
        assert.match((e as Error).message, /1\.50 is 150/);
        return true;
      },
    );
  });

  test("rejects negatives, NaN, Infinity and unsafe integers", () => {
    assert.throws(() => money(-1, "NGN"), MoneyError);
    assert.throws(() => money(Number.NaN, "NGN"), MoneyError);
    assert.throws(() => money(Number.POSITIVE_INFINITY, "NGN"), MoneyError);
    assert.throws(() => money(Number.MAX_SAFE_INTEGER + 2, "NGN"), MoneyError);
  });

  test("rejects an unknown currency", () => {
    // @ts-expect-error deliberately wrong, to prove the runtime guard exists too
    assert.throws(() => money(100, "GBP"), /unknown currency/);
  });

  test("is frozen, so an amount cannot be mutated after validation", () => {
    const m = naira(100);
    assert.throws(() => {
      (m as { amount: number }).amount = 999;
    }, TypeError);
  });
});

describe("fromMajor", () => {
  test("handles the classic float multiplication trap", () => {
    // 1.15 * 100 is 114.99999999999999 in IEEE 754
    assert.equal(fromMajor(1.15, "NGN").amount, 115);
    assert.equal(fromMajor(0.07, "NGN").amount, 7);
    assert.equal(fromMajor(150.75, "NGN").amount, 15_075);
  });

  test("refuses more precision than the currency has", () => {
    assert.throws(() => fromMajor(1.005, "NGN"), /more precision/);
  });

  test("refuses a fractional XOF amount rather than letting it be dropped", () => {
    assert.equal(fromMajor(100, "XOF").amount, 10_000);
    assert.throws(() => fromMajor(100.5, "XOF"), /no subunit/);
  });
});

describe("arithmetic", () => {
  test("adds and subtracts within one currency", () => {
    assert.equal(add(naira(10), naira(5)).amount, 1_500);
    assert.equal(subtract(naira(10), naira(5)).amount, 500);
  });

  test("refuses to mix currencies", () => {
    assert.throws(() => add(naira(10), money(500, "USD")), /cannot combine NGN and USD/);
  });

  test("refuses to produce a negative amount", () => {
    assert.throws(() => subtract(naira(5), naira(10)), /negative/);
  });

  test("compares and equates", () => {
    assert.equal(compare(naira(5), naira(10)), -1);
    assert.equal(compare(naira(10), naira(10)), 0);
    assert.equal(compare(naira(15), naira(10)), 1);
    assert.ok(equals(naira(10), money(1_000, "NGN")));
    assert.ok(!equals(naira(10), money(1_000, "USD")));
  });

  test("formats for humans", () => {
    assert.equal(format(money(15_075, "NGN")), "NGN 150.75");
    assert.equal(format(money(5, "NGN")), "NGN 0.05");
    assert.equal(format(money(0, "NGN")), "NGN 0.00");
  });
});

describe("splits", () => {
  test("splits by basis points and gives the remainder to the main account", () => {
    const result = splitByBasisPoints(naira(100), [{ account: "vendor", share: 9_000 }]);
    assert.equal(result.parts.length, 1);
    assert.equal(result.parts[0]?.amount.amount, 9_000);
    assert.equal(result.remainder.amount, 1_000);
  });

  test("a split that does not divide evenly loses nothing", () => {
    // 10001 kobo split three ways at 33.33% each
    const total = money(10_001, "NGN");
    const result = splitByBasisPoints(total, [
      { account: "a", share: 3_333 },
      { account: "b", share: 3_333 },
      { account: "c", share: 3_333 },
    ]);
    const paid = result.parts.reduce((sum, p) => sum + p.amount.amount, 0);
    assert.equal(paid + result.remainder.amount, 10_001);
    // Each party is floored, so nobody is over-paid by a rounding artefact
    for (const p of result.parts) assert.equal(p.amount.amount, 3_333);
  });

  test("refuses shares totalling more than 100%", () => {
    assert.throws(
      () =>
        splitByBasisPoints(naira(100), [
          { account: "a", share: 6_000 },
          { account: "b", share: 5_000 },
        ]),
      /more than 100%/,
    );
  });

  test("refuses a fractional basis-point share", () => {
    assert.throws(
      () => splitByBasisPoints(naira(100), [{ account: "a", share: 12.5 }]),
      /non-negative integer/,
    );
  });

  test("splits by flat amounts", () => {
    const result = splitByFlatAmounts(naira(100), [{ account: "a", share: 2_500 }]);
    assert.equal(result.parts[0]?.amount.amount, 2_500);
    assert.equal(result.remainder.amount, 7_500);
  });

  test("refuses flat shares exceeding the total, which would pay out more than came in", () => {
    assert.throws(
      () => splitByFlatAmounts(naira(10), [{ account: "a", share: 2_000 }]),
      /more than the 1000 being split/,
    );
  });

  test("property: parts plus remainder always equal the total, for any amount and shares", () => {
    // Deterministic pseudo-random so a failure is reproducible from the seed.
    let seed = 42;
    const next = (max: number) => {
      seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
      return seed % max;
    };

    for (let i = 0; i < 2_000; i++) {
      const total = money(next(50_000_000), "NGN");
      const count = 1 + next(5);
      const shares = [];
      let budget = BASIS_POINTS_TOTAL;
      for (let p = 0; p < count && budget > 0; p++) {
        const share = next(budget + 1);
        budget -= share;
        shares.push({ account: `p${p}`, share });
      }

      const result = splitByBasisPoints(total, shares);
      const paid = result.parts.reduce((sum, part) => sum + part.amount.amount, 0);

      assert.equal(
        paid + result.remainder.amount,
        total.amount,
        `lost or invented value: total=${total.amount} shares=${JSON.stringify(shares)}`,
      );
      assert.ok(result.remainder.amount >= 0, "remainder must never be negative");
      for (const part of result.parts) {
        assert.ok(Number.isInteger(part.amount.amount), "every part must be an integer");
      }
    }
  });
});

describe("decimal conversion, for providers whose wire format is not minor units", () => {
  test("toMajor is the inverse of fromMajor", () => {
    for (const major of [0, 1, 1.5, 12.34, 150.75, 1200.09, 20_000.5, 3.29, 999_999.99]) {
      const m = fromMajor(major, "NGN");
      assert.equal(toMajor(m), major, `${major} did not round-trip`);
    }
  });

  test("the cases a naive multiply by 100 gets wrong", () => {
    // 1200.09 * 100 is 120008.99999999999 and 3.29 * 100 is 328.99999999999994.
    // Truncating either loses a kobo; these are the exact values that must come out.
    assert.equal(fromMajor(1200.09, "NGN").amount, 120_009);
    assert.equal(fromMajor(3.29, "USD").amount, 329);
    assert.equal(fromMajor(1.15, "NGN").amount, 115);
    assert.equal(toMajor(money(120_009, "NGN")), 1200.09);
    assert.equal(toMajor(money(329, "USD")), 3.29);
  });

  test("the decimal a provider receives serialises as the decimal we meant", () => {
    // JSON.stringify prints the shortest round-tripping representation, which is the
    // property that makes sending a converted number safe at all.
    assert.equal(JSON.stringify({ amount: toMajor(money(120_009, "NGN")) }), '{"amount":1200.09}');
    assert.equal(
      JSON.stringify({ amount: toMajor(money(2_000_050, "NGN")) }),
      '{"amount":20000.5}',
    );
  });

  test("every kobo value up to a thousand naira round-trips exactly", () => {
    for (let kobo = 0; kobo <= 100_000; kobo++) {
      const m = money(kobo, "NGN");
      assert.equal(fromMajor(toMajor(m), "NGN").amount, kobo);
    }
  });

  test("refuses a fractional amount in a currency with no subunit", () => {
    // Found by the cross-language parity cases: toMajor used to emit 0.01 XOF, which
    // fromMajor then rejected, so the round trip was broken for the one currency
    // without a subunit. A provider would have dropped the fraction silently.
    assert.throws(() => toMajor(money(1, "XOF")), MoneyError);
    assert.throws(() => toMajor(money(150, "XOF")), MoneyError);
    // A whole number of XOF is fine.
    assert.equal(toMajor(money(100, "XOF")), 1);
    assert.equal(toMajor(money(500_000, "XOF")), 5000);
  });

  test("basis points become the decimal fraction a provider expects", () => {
    // Flutterwave's own documentation: a 9% commission is 0.09, not 9.
    assert.equal(basisPointsToFraction(900), 0.09);
    assert.equal(basisPointsToFraction(2000), 0.2);
    assert.equal(basisPointsToFraction(0), 0);
    assert.equal(basisPointsToFraction(BASIS_POINTS_TOTAL), 1);
    assert.equal(basisPointsToFraction(5000), 0.5);
  });

  test("refuses basis points that are not whole, negative, or over 100%", () => {
    assert.throws(() => basisPointsToFraction(1.5), MoneyError);
    assert.throws(() => basisPointsToFraction(-1), MoneyError);
    assert.throws(() => basisPointsToFraction(BASIS_POINTS_TOTAL + 1), MoneyError);
  });
});
