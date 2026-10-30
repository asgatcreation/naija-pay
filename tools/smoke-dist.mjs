#!/usr/bin/env node

/**
 * Smoke-tests the BUILT package, as a consumer would see it.
 *
 * The unit tests run against the TypeScript sources, which only proves the sources are
 * correct. This loads `dist/` — both the ESM and CJS output — and exercises one real
 * path through each entry point. It is what makes the Node 20 support claim true rather
 * than asserted: the sources need Node 22+ to run directly, but the compiled output must
 * work on the floor the package declares.
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "packages", "ts", "dist");
const require = createRequire(import.meta.url);

const esm = (relative) => import(pathToFileURL(path.join(DIST, relative)).href);

let checks = 0;
const check = (label, fn) => {
  fn();
  checks++;
  console.log(`  ok  ${label}`);
};

console.log("ESM:");

const core = await esm("index.js");

check("money is integer kobo", () => {
  assert.equal(core.naira(150).amount, 15_000);
  assert.throws(() => core.money(1.5, "NGN"), /must be an integer/);
});

check("splits keep every kobo", () => {
  const result = core.splitByBasisPoints(core.money(10_001, "NGN"), [
    { account: "a", share: 3_333 },
    { account: "b", share: 3_333 },
    { account: "c", share: 3_333 },
  ]);
  const paid = result.parts.reduce((sum, p) => sum + p.amount.amount, 0);
  assert.equal(paid + result.remainder.amount, 10_001);
});

check("redaction masks a BVN", () => {
  const out = core.redact("bvn 22222222222");
  assert.ok(!out.includes("22222222222"));
});

check("the core does NOT carry bank matching", () => {
  // Proof the entry point really is split: if this ever starts existing, the root
  // bundle has silently grown by the whole institution registry again.
  assert.equal(core.matchInstitution, undefined);
});

{
  const body = new TextEncoder().encode('{"event":"charge.success"}');
  const signature = await core.computeSignature(core.SCHEMES.paystack, body, "sk_test_EXAMPLE1");
  const result = await core.verifySignature({
    scheme: core.SCHEMES.paystack,
    body,
    headers: { "x-paystack-signature": signature },
    secret: "sk_test_EXAMPLE1",
  });
  assert.ok(result.verified);
  assert.equal(result.strength, "full-body");
  checks++;
  console.log("  ok  signature round trip");
}

const banks = await esm("banks.js");
check("bank matching resolves a real institution", () => {
  const match = banks.matchInstitution({ code: "044" });
  assert.equal(match.institution.id, "access-bank");
  assert.match(banks.bankDataSource.attribution, /naija-data/);
});

const mock = await esm("providers/mock/index.js");
{
  const provider = mock.mock();
  const webhook = await provider.simulateInflow({
    expectedAmount: core.naira(5_000),
    amountPaid: core.naira(5_500),
  });
  const verified = await core.verifySignature({
    scheme: mock.MOCK_SCHEME,
    body: webhook.body,
    headers: webhook.headers,
    secret: provider.secret,
  });
  assert.ok(verified.verified);
  assert.equal(webhook.event.data.variance, "overpayment");
  checks++;
  console.log("  ok  mock provider signs a verifiable overpayment webhook");
}

const paystack = await esm("providers/paystack/index.js");
check("paystack refuses a live key in a test environment", () => {
  assert.throws(
    () => paystack.paystack({ secretKey: "sk_live_EXAMPLEreal", environment: "test" }),
    /LIVE secret key/,
  );
});

console.log("\nCJS:");

const coreCjs = require(path.join(DIST, "index.cjs"));
check("CJS core loads and money still works", () => {
  assert.equal(coreCjs.naira(150).amount, 15_000);
});

const paystackCjs = require(path.join(DIST, "providers", "paystack", "index.cjs"));
check("CJS paystack loads and still validates keys", () => {
  assert.throws(() => paystackCjs.paystack({ secretKey: "pk_test_EXAMPLE1" }), /secret key/);
});

console.log(`\n${checks} checks passed against the built output on Node ${process.versions.node}`);
