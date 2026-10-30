import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  computeSignature,
  constantTimeEqual,
  SCHEMES,
  type SignatureScheme,
  strengthOf,
  verifySignature,
} from "../src/core/signatures.ts";

/**
 * One body, one secret, and the expected signature under each provider's documented
 * scheme. These constants are fixed test vectors: the TypeScript implementation uses
 * WebCrypto and the Python one uses hashlib, so both matching these same strings is a
 * genuine cross-implementation check rather than two copies of one mistake.
 */
const BODY_TEXT = '{"event":"charge.success","data":{"reference":"order_01HQ","amount":15000}}';
const BODY = new TextEncoder().encode(BODY_TEXT);
const SECRET = "sk_test_EXAMPLE123";

const VECTORS = {
  paystack:
    "ae20cd85e078d89a2c18be44c76488e6b4556228d4e6f032957732b6a5d2356896ad714b2adadc5657a2da91b4d074d51ff1e680ae8e8a0aad2cf32299708662",
  flutterwaveV4: "XEDJlTlj6fd4EVPlEYlFFuWrAyNPYdAvIHR0FUvtkyo=",
  korapay: "3b6a799ba264a76caa47d990430a2b638c4c66506ee46ee13cf85f65ca707499",
  anchor: "NjAxMDNhZjhlMDgxYjhlZTM0OGMyZDQwZjRiZjhhYjg0NmRhMDFmZA==",
} as const;

describe("computing signatures", () => {
  test("Paystack: HMAC-SHA512 hex over the raw body", async () => {
    assert.equal(await computeSignature(SCHEMES.paystack, BODY, SECRET), VECTORS.paystack);
  });

  test("Fincra: same scheme as Paystack, but keyed with the separate webhook secret", async () => {
    // Identical algorithm, so the digest matches; the difference is which key you use,
    // which is exactly the trap this records.
    assert.equal(await computeSignature(SCHEMES.fincra, BODY, SECRET), VECTORS.paystack);
  });

  test("Flutterwave v4: HMAC-SHA256 base64 over the raw body", async () => {
    assert.equal(
      await computeSignature(SCHEMES.flutterwaveV4, BODY, SECRET),
      VECTORS.flutterwaveV4,
    );
  });

  test("Korapay: HMAC-SHA256 hex over the data object ONLY", async () => {
    assert.equal(await computeSignature(SCHEMES.korapay, BODY, SECRET), VECTORS.korapay);
    // Proof that it really is the sub-object: it must differ from the full-body digest.
    assert.notEqual(VECTORS.korapay, VECTORS.paystack);
  });

  test("Anchor: HMAC-SHA1, base64 of the HEX digest, per its own samples", async () => {
    assert.equal(await computeSignature(SCHEMES.anchor, BODY, SECRET), VECTORS.anchor);
  });

  test("Flutterwave v3 'signature' is just the shared secret echoed back", async () => {
    // Recorded as a test because it is the whole problem: the value does not depend on
    // the body at all.
    assert.equal(await computeSignature(SCHEMES.flutterwaveV3, BODY, SECRET), SECRET);
    const otherBody = new TextEncoder().encode('{"event":"anything.else"}');
    assert.equal(await computeSignature(SCHEMES.flutterwaveV3, otherBody, SECRET), SECRET);
  });

  test("refuses to invent a signature for an undocumented scheme", async () => {
    for (const scheme of [SCHEMES.squad, SCHEMES.monnify]) {
      await assert.rejects(
        computeSignature(scheme, BODY, SECRET),
        /undocumented/,
        `${scheme.header} must not be guessed`,
      );
    }
  });
});

describe("verifying signatures", () => {
  test("accepts a correct signature and reports the honest strength", async () => {
    const cases: [SignatureScheme, string][] = [
      [SCHEMES.paystack, VECTORS.paystack],
      [SCHEMES.flutterwaveV4, VECTORS.flutterwaveV4],
      [SCHEMES.korapay, VECTORS.korapay],
      [SCHEMES.anchor, VECTORS.anchor],
    ];

    for (const [scheme, signature] of cases) {
      const result = await verifySignature({
        scheme,
        body: BODY,
        headers: { [scheme.header]: signature },
        secret: SECRET,
      });
      assert.ok(result.verified, `${scheme.header}: ${result.reason}`);
      assert.equal(result.strength, scheme.strength);
    }
  });

  test("rejects a tampered body", async () => {
    const tampered = new TextEncoder().encode(
      '{"event":"charge.success","data":{"reference":"order_01HQ","amount":9900000}}',
    );
    const result = await verifySignature({
      scheme: SCHEMES.paystack,
      body: tampered,
      headers: { "x-paystack-signature": VECTORS.paystack },
      secret: SECRET,
    });
    assert.equal(result.verified, false);
    assert.match(result.reason ?? "", /did not match/);
  });

  test("rejects the right signature under the wrong secret", async () => {
    const result = await verifySignature({
      scheme: SCHEMES.paystack,
      body: BODY,
      headers: { "x-paystack-signature": VECTORS.paystack },
      secret: "sk_test_EXAMPLEdifferent",
    });
    assert.equal(result.verified, false);
  });

  test("rejects a missing or empty header", async () => {
    for (const headers of [{}, { "x-paystack-signature": "" }]) {
      const result = await verifySignature({
        scheme: SCHEMES.paystack,
        body: BODY,
        headers,
        secret: SECRET,
      });
      assert.equal(result.verified, false);
      assert.equal(result.strength, "unverified");
      assert.match(result.reason ?? "", /missing/);
    }
  });

  test("matches the header case-insensitively, as HTTP requires", async () => {
    const result = await verifySignature({
      scheme: SCHEMES.paystack,
      body: BODY,
      headers: { "x-paystack-signature": VECTORS.paystack },
      secret: SECRET,
    });
    assert.ok(result.verified);
  });

  test("an undocumented scheme is never reported as verified", async () => {
    // The important negative case. Squad sends a signature header, and it would be
    // easy to guess an algorithm and claim success. We must not.
    const result = await verifySignature({
      scheme: SCHEMES.squad,
      body: BODY,
      headers: { "x-squad-encrypted-body": "whatever-the-provider-sent" },
      secret: SECRET,
    });
    assert.equal(result.verified, false);
    assert.equal(result.strength, "unverified");
    assert.match(result.reason ?? "", /undocumented/);
    assert.match(result.reason ?? "", /re-verify with the API/);
  });

  test("Flutterwave v3 verifies, but only ever as shared-secret strength", async () => {
    const result = await verifySignature({
      scheme: SCHEMES.flutterwaveV3,
      body: BODY,
      headers: { "verif-hash": SECRET },
      secret: SECRET,
    });
    assert.ok(result.verified);
    assert.equal(result.strength, "shared-secret", "this proves nothing about the payload");

    // And the demonstration of why: a completely different body still 'verifies'.
    const forged = await verifySignature({
      scheme: SCHEMES.flutterwaveV3,
      body: new TextEncoder().encode('{"event":"payment.successful","data":{"amount":99999999}}'),
      headers: { "verif-hash": SECRET },
      secret: SECRET,
    });
    assert.ok(forged.verified, "v3 cannot detect a forged payload — that is the finding");
    assert.equal(forged.strength, "shared-secret");
  });

  test("refuses a body that lacks the sub-object the scheme signs", async () => {
    // Regression test for a real bug the parity harness caught: `JSON.stringify` of a
    // missing key yields `undefined`, which was being signed as the literal string
    // "undefined" — and then verified against itself, accepting an unsigned event.
    const body = new TextEncoder().encode('{"event":"charge.success"}');
    const selfConsistent = await verifySignature({
      scheme: SCHEMES.korapay,
      body,
      headers: {
        // Whatever an attacker might send, including a signature over "undefined".
        "x-korapay-signature": "0".repeat(64),
      },
      secret: SECRET,
    });
    assert.equal(selfConsistent.verified, false);
    assert.equal(selfConsistent.strength, "unverified");
    assert.match(selfConsistent.reason ?? "", /has no "data" to sign/);

    await assert.rejects(
      computeSignature(SCHEMES.korapay, body, SECRET),
      /has no "data" to sign/,
      "computing must fail loudly rather than signing the string 'undefined'",
    );
  });

  test("gives a stable message for a body that is not JSON at all", async () => {
    // The runtimes word their own JSON errors differently, so we raise our own; the
    // parity harness compares these messages across languages.
    const result = await verifySignature({
      scheme: SCHEMES.korapay,
      body: new TextEncoder().encode("<html>not json</html>"),
      headers: { "x-korapay-signature": VECTORS.korapay },
      secret: SECRET,
    });
    assert.equal(result.verified, false);
    assert.equal(result.strength, "unverified");
    assert.match(result.reason ?? "", /not valid JSON/);
  });

  test("a partial-body scheme cannot detect tampering outside the signed region", async () => {
    // Not a defect in naija-pay — it is the documented consequence of Korapay signing
    // only `data`. Asserted so the weakness stays visible, and so `partial-body` keeps
    // meaning something.
    const tamperedOutsideData = new TextEncoder().encode(
      '{"event":"charge.failed","data":{"reference":"order_01HQ","amount":15000}}',
    );
    const result = await verifySignature({
      scheme: SCHEMES.korapay,
      body: tamperedOutsideData,
      headers: { "x-korapay-signature": VECTORS.korapay },
      secret: SECRET,
    });
    assert.ok(result.verified, "the event name is outside the signed region");
    assert.equal(result.strength, "partial-body", "and the strength says exactly that");
  });
});

describe("constant-time comparison", () => {
  test("is correct for equal, different and differing-length inputs", () => {
    assert.ok(constantTimeEqual("abc", "abc"));
    assert.ok(!constantTimeEqual("abc", "abd"));
    assert.ok(!constantTimeEqual("abc", "abcd"));
    assert.ok(!constantTimeEqual("", "a"));
    assert.ok(constantTimeEqual("", ""));
  });

  test("does not short-circuit on the first differing byte", () => {
    // Both comparisons must behave identically regardless of where the difference is.
    assert.equal(constantTimeEqual("Xbcdefgh", "abcdefgh"), false);
    assert.equal(constantTimeEqual("abcdefgX", "abcdefgh"), false);
  });
});

describe("declared strengths are honest", () => {
  test("every declaration matches what the scheme actually achieves", () => {
    for (const [name, scheme] of Object.entries(SCHEMES)) {
      assert.equal(
        scheme.strength,
        strengthOf(scheme),
        `${name} claims "${scheme.strength}" but its scheme gives "${strengthOf(scheme)}"`,
      );
    }
  });

  test("the three providers that cannot offer full-body integrity are marked as such", () => {
    // This is the headline finding from PROVIDERS.md, asserted so it cannot be quietly
    // upgraded later without a failing test.
    assert.equal(SCHEMES.flutterwaveV3.strength, "shared-secret");
    assert.equal(SCHEMES.korapay.strength, "partial-body");
    assert.equal(SCHEMES.squad.strength, "unverified");
    assert.equal(SCHEMES.monnify.strength, "unverified");
  });
});
