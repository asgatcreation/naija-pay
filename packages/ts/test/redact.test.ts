import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  looksLikeLiveKey,
  looksLikeTestKey,
  maskAccountNumber,
  maskIdentityNumber,
  redact,
  redactObject,
} from "../src/core/redact.ts";

/** Obviously fake values, matching the ones the fixtures use. */
const BVN = "22222222222";
const NIN = "12345678901";
const ACCOUNT = "0123456789";

describe("redact in free text", () => {
  test("masks a BVN but keeps it correlatable", () => {
    const out = redact(`verification failed for bvn ${BVN}`);
    assert.ok(!out.includes(BVN), `BVN leaked: ${out}`);
    assert.match(out, /22\*+222/);
  });

  test("masks a NIN and a NUBAN account number", () => {
    const out = redact(`nin ${NIN} account ${ACCOUNT}`);
    assert.ok(!out.includes(NIN));
    assert.ok(!out.includes(ACCOUNT));
  });

  test("masks every provider's key format, keeping the prefix", () => {
    const cases: [string, string][] = [
      ["sk_test_abc123def456", "sk_test_"],
      ["sk_live_EXAMPLEdef456", "sk_live_"],
      ["sandbox_sk_abc123def456", "sandbox_sk_"],
      ["FLWSECK_TEST-abc123def456-X", "FLWSECK_TEST-"],
      ["FLWSECK-EXAMPLEdef456", "FLWSECK-"],
      ["MK_TEST_GC3B8XG2XX", "MK_TEST_"],
      ["Bearer abc123def456ghi", "Bearer "],
    ];
    for (const [secret, prefix] of cases) {
      const out = redact(`request used ${secret} for auth`);
      assert.ok(!out.includes(secret), `key leaked: ${out}`);
      assert.ok(out.includes(prefix), `prefix lost, so the leak is unidentifiable: ${out}`);
      assert.ok(out.includes("[redacted]"));
    }
  });

  test("masks a card number entirely", () => {
    const out = redact("pan 4242424242424242 declined");
    assert.ok(!out.includes("4242424242424242"));
    assert.ok(out.includes("[redacted]"));
  });

  test("leaves ordinary text and short numbers alone", () => {
    assert.equal(redact("transaction failed with code 404"), "transaction failed with code 404");
    assert.equal(redact("amount 15000 kobo"), "amount 15000 kobo");
  });

  test("handles empty and non-string input without throwing", () => {
    assert.equal(redact(""), "");
    // @ts-expect-error deliberately wrong, to prove the guard
    assert.equal(redact(undefined), undefined);
  });
});

describe("redactObject", () => {
  test("masks sensitive fields by name and leaves the rest readable", () => {
    const payload = {
      event: "charge.success",
      reference: "order_01HQ",
      amount: 15_000,
      customer: { email: "ada@example.com", phone: "+2348100000000", bvn: BVN },
      account: { accountNumber: ACCOUNT, bankCode: "058" },
      secretKey: "sk_live_EXAMPLEdef456",
      authorization: "Bearer abc123def456ghi",
    };
    const out = redactObject(payload) as Record<string, any>;

    // Still useful for debugging
    assert.equal(out.event, "charge.success");
    assert.equal(out.reference, "order_01HQ");
    assert.equal(out.amount, 15_000);
    assert.equal(out.account.bankCode, "058");
    assert.equal(out.customer.email, "ada@example.com");

    // Masked
    assert.equal(out.secretKey, "[redacted]");
    assert.equal(out.authorization, "[redacted]");
    assert.ok(!JSON.stringify(out).includes(BVN), "BVN leaked");
    assert.ok(!JSON.stringify(out).includes(ACCOUNT), "account number leaked");
    assert.ok(!JSON.stringify(out).includes("sk_live_EXAMPLEdef456"), "key leaked");
  });

  test("matches field names regardless of case or separators", () => {
    const out = redactObject({
      secret_key: "sk_live_EXAMPLEaaaaaa",
      "SECRET-KEY": "sk_live_EXAMPLEbbbbbb",
      accountNumber: ACCOUNT,
      account_number: ACCOUNT,
    }) as Record<string, unknown>;

    assert.equal(out.secret_key, "[redacted]");
    assert.equal(out["SECRET-KEY"], "[redacted]");
    assert.ok(!String(out.accountNumber).includes(ACCOUNT));
    assert.ok(!String(out.account_number).includes(ACCOUNT));
  });

  test("catches a sensitive value hiding in an unremarkable field", () => {
    // A BVN in a `reason` field is just as sensitive as one in a `bvn` field.
    const out = redactObject({ reason: `BVN ${BVN} does not match account ${ACCOUNT}` });
    assert.ok(!JSON.stringify(out).includes(BVN));
    assert.ok(!JSON.stringify(out).includes(ACCOUNT));
  });

  test("walks arrays and survives cycles", () => {
    const cyclic: Record<string, unknown> = { bvn: BVN };
    cyclic.self = cyclic;
    const out = redactObject({ items: [{ bvn: BVN }, { accountNumber: ACCOUNT }], cyclic }) as any;
    assert.ok(!JSON.stringify(out).includes(BVN));
    assert.equal(out.cyclic.self, "[circular]");
  });

  test("does not mutate the input, which the caller still intends to use", () => {
    const original = { bvn: BVN, nested: { secretKey: "sk_live_EXAMPLEdef456" } };
    redactObject(original);
    assert.equal(original.bvn, BVN);
    assert.equal(original.nested.secretKey, "sk_live_EXAMPLEdef456");
  });
});

describe("masking helpers", () => {
  test("keeps the ends so records stay correlatable", () => {
    assert.equal(maskAccountNumber(ACCOUNT), "012****789");
    assert.equal(maskIdentityNumber(BVN), "222*****222");
  });

  test("masks a short value entirely rather than revealing most of it", () => {
    assert.equal(maskAccountNumber("12345"), "*****");
  });
});

describe("key environment detection", () => {
  test("recognises live keys", () => {
    assert.ok(looksLikeLiveKey("sk_live_EXAMPLE123"));
    assert.ok(looksLikeLiveKey("FLWSECK-EXAMPLE123"));
    assert.ok(looksLikeLiveKey("MK_PROD_EXAMPLE123"));
    assert.ok(!looksLikeLiveKey("sk_test_abc123"));
    assert.ok(!looksLikeLiveKey("FLWSECK_TEST-abc123"));
  });

  test("recognises test keys", () => {
    assert.ok(looksLikeTestKey("sk_test_abc123"));
    assert.ok(looksLikeTestKey("sandbox_sk_abc123"));
    assert.ok(looksLikeTestKey("FLWSECK_TEST-abc123"));
    assert.ok(looksLikeTestKey("MK_TEST_GC3B8XG2XX"));
    assert.ok(!looksLikeTestKey("sk_live_EXAMPLE123"));
  });

  test("a key is never both, which is what the environment check relies on", () => {
    for (const key of [
      "sk_test_abc123",
      "sk_live_EXAMPLE123",
      "FLWSECK_TEST-abc123",
      "FLWSECK-EXAMPLE123",
      "MK_TEST_abc",
      "MK_PROD_EXAMPLE",
      "sandbox_sk_abc123",
    ]) {
      assert.ok(
        !(looksLikeLiveKey(key) && looksLikeTestKey(key)),
        `${key} was classified as both test and live`,
      );
    }
  });
});
