#!/usr/bin/env node
/**
 * Runs the shared parity cases through the TypeScript package and prints canonical
 * JSON on stdout. The Python runner does the same, and `tools/check-parity.mjs`
 * compares the two byte for byte.
 *
 * Nothing is printed except the JSON, so a stray console.log in the package shows up
 * as a parity failure rather than being silently tolerated.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = path.join(ROOT, "packages", "ts", "src");

// On Windows a bare absolute path is not a valid ESM specifier ("c:" reads as a URL
// scheme), so every dynamic import goes through pathToFileURL.
const load = (...segments) => import(pathToFileURL(path.join(SRC, ...segments)).href);

const { fromMajor, format, money, splitByBasisPoints, splitByFlatAmounts } = await load(
  "core",
  "money.ts",
);
const { redact, redactObject, looksLikeLiveKey, looksLikeTestKey } = await load(
  "core",
  "redact.ts",
);
const { errorClassForStatus } = await load("core", "errors.ts");
const { SCHEMES, computeSignature, strengthOf, verifySignature } = await load(
  "core",
  "signatures.ts",
);

const cases = JSON.parse(
  readFileSync(path.join(ROOT, "fixtures", "parity", "core.json"), "utf8"),
);

/**
 * Both languages must describe a rejection identically. We compare the error's class
 * name and message, because an SDK whose two implementations disagree about *why*
 * something was refused is only half-ported.
 */
function attempt(fn) {
  try {
    return { ok: true, value: fn() };
  } catch (error) {
    return { ok: false, error: error.name, message: error.message };
  }
}

const out = {};

out.fromMajor = cases.fromMajor.map((c) =>
  attempt(() => {
    const m = fromMajor(c.major, c.currency);
    return { amount: m.amount, currency: m.currency };
  }),
);

out.format = cases.format.map((c) => attempt(() => format(money(c.amount, c.currency))));

const splitOut = (result) => ({
  parts: result.parts.map((p) => ({
    account: p.account,
    amount: p.amount.amount,
    currency: p.amount.currency,
  })),
  remainder: result.remainder.amount,
});

out.splitByBasisPoints = cases.splitByBasisPoints.map((c) =>
  attempt(() => splitOut(splitByBasisPoints(money(c.total.amount, c.total.currency), c.shares))),
);

out.splitByFlatAmounts = cases.splitByFlatAmounts.map((c) =>
  attempt(() => splitOut(splitByFlatAmounts(money(c.total.amount, c.total.currency), c.shares))),
);

out.redact = cases.redact.map((s) => redact(s));
out.redactObject = cases.redactObject.map((o) => redactObject(o));
out.keyDetection = cases.keyDetection.map((k) => ({
  key: k,
  live: looksLikeLiveKey(k),
  test: looksLikeTestKey(k),
}));
out.errorForStatus = cases.errorForStatus.map((s) => errorClassForStatus(s).name);

/** Async variant of `attempt`, for the WebCrypto-backed signature functions. */
async function attemptAsync(fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error: error.name, message: error.message };
  }
}

const encoder = new TextEncoder();

out.signatures = [];
for (const c of cases.signatures) {
  const scheme = SCHEMES[c.scheme];
  const body = encoder.encode(c.body);

  const computed = await attemptAsync(() => computeSignature(scheme, body, c.secret));

  // Verify with whatever was computed. For undocumented schemes nothing can be
  // computed, so a fixed placeholder is used and both languages must agree that the
  // result is unverified.
  const signature = computed.ok ? computed.value : "cannot-be-computed";
  const verification = await verifySignature({
    scheme,
    body,
    headers: { [scheme.header]: signature },
    secret: c.secret,
  });

  // Tampering must be detected identically in both languages.
  const tamperedVerification = await verifySignature({
    scheme,
    body: encoder.encode(`${c.body} `),
    headers: { [scheme.header]: signature },
    secret: c.secret,
  });

  out.signatures.push({
    scheme: c.scheme,
    computed,
    verified: verification.verified,
    strength: verification.strength,
    reason: verification.reason ?? null,
    tamperedVerified: tamperedVerification.verified,
    tamperedStrength: tamperedVerification.strength,
  });
}

out.signatureStrengths = cases.signatureStrengths.map((name) => ({
  scheme: name,
  declared: SCHEMES[name].strength,
  derived: strengthOf(SCHEMES[name]),
  header: SCHEMES[name].header,
  algorithm: SCHEMES[name].algorithm ?? null,
}));

/** Sort object keys recursively so key order can never cause a false difference. */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    const sorted = {};
    for (const key of Object.keys(value).sort()) sorted[key] = canonical(value[key]);
    return sorted;
  }
  return value;
}

process.stdout.write(`${JSON.stringify(canonical(out), null, 2)}\n`);
