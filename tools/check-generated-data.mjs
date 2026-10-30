#!/usr/bin/env node
/**
 * Validates `data/banks.generated.json` offline — no network, fully deterministic.
 *
 * This runs in CI on every push. It deliberately does NOT regenerate from naija-data:
 * that would make this build fail whenever naija-data ships a new bank, which is
 * someone else's commit breaking our CI, and the fastest way to get a useful check
 * switched off. Detecting upstream change is the weekly drift workflow's job, which
 * opens an issue rather than blocking a merge.
 *
 * What it does check is that the committed file is internally trustworthy, because a
 * payout is built from this data.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FILE = path.join(ROOT, "data", "banks.generated.json");

let failed = false;
const fail = (msg) => {
  console.error(`FAIL  ${msg}`);
  failed = true;
};

let data;
try {
  data = JSON.parse(readFileSync(FILE, "utf8"));
} catch (error) {
  console.error(`FAIL  could not parse data/banks.generated.json: ${error.message}`);
  process.exit(1);
}

// --- attribution -------------------------------------------------------------
// naija-data's dataset is CC BY 4.0. Losing the attribution would be a licence
// breach, so it is checked rather than trusted.
if (!data.source?.attribution?.includes("naija-data")) {
  fail("the CC BY 4.0 attribution for naija-data is missing from the source block");
}
if (data.source?.licence !== "CC-BY-4.0") {
  fail(`unexpected licence "${data.source?.licence}"; expected CC-BY-4.0`);
}
if (!data.source?.dataVersion || data.source.dataVersion === "unknown") {
  fail("source.dataVersion is missing, so we cannot say which naija-data release this is");
}

// --- shape -------------------------------------------------------------------
const banks = data.banks;
if (!Array.isArray(banks) || banks.length === 0) {
  console.error("FAIL  banks is not a non-empty array");
  process.exit(1);
}

const VALID_STATUS = new Set(["active", "merged"]);
const VALID_TYPES = new Set([
  "commercial",
  "merchant",
  "non_interest",
  "payment_service_bank",
  "mobile_money_operator",
  "microfinance",
  "mortgage",
  "development_finance",
]);

const ids = new Set();
for (const [i, bank] of banks.entries()) {
  const where = `banks[${i}] (${bank.id ?? "no id"})`;
  if (!bank.id || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(bank.id)) fail(`${where}: invalid id`);
  if (ids.has(bank.id)) fail(`${where}: duplicate id`);
  ids.add(bank.id);
  if (!bank.name) fail(`${where}: missing name`);
  if (!VALID_STATUS.has(bank.status)) fail(`${where}: unexpected status "${bank.status}"`);
  if (!VALID_TYPES.has(bank.type)) fail(`${where}: unexpected type "${bank.type}"`);
  // Codes keep naija-data's own shapes: CBN is 3 or 5 digits, NIP is 6.
  if (bank.cbnCode && !/^\d{3}$|^\d{5}$/.test(bank.cbnCode)) {
    fail(`${where}: cbnCode "${bank.cbnCode}" is not 3 or 5 digits`);
  }
  if (bank.nipCode && !/^\d{6}$/.test(bank.nipCode)) {
    fail(`${where}: nipCode "${bank.nipCode}" is not 6 digits`);
  }
  // A merged institution must say where it went, or a caller cannot be warned.
  if (bank.status === "merged" && !bank.mergedInto) {
    fail(`${where}: status is merged but mergedInto is missing`);
  }
  if (bank.mergedInto && !bank.mergedInto.match(/^[a-z0-9]+(-[a-z0-9]+)*$/)) {
    fail(`${where}: mergedInto "${bank.mergedInto}" is not a valid id`);
  }
}

// Every mergedInto must point at an institution we actually carry, otherwise the
// warning we give a caller would dead-end.
for (const bank of banks) {
  if (bank.mergedInto && !ids.has(bank.mergedInto)) {
    fail(`${bank.id}: mergedInto "${bank.mergedInto}" is not in this dataset`);
  }
}

// --- code uniqueness among active institutions -------------------------------
// This is the money-safety check. If two active institutions shared a code, a lookup
// by code would be ambiguous and a payout could be enriched with the wrong bank.
for (const field of ["cbnCode", "nipCode"]) {
  const seen = new Map();
  for (const bank of banks.filter((b) => b.status === "active" && b[field])) {
    const previous = seen.get(bank[field]);
    if (previous) fail(`${field} ${bank[field]} is shared by ${previous} and ${bank.id}`);
    else seen.set(bank[field], bank.id);
  }
}

// --- counts match contents ---------------------------------------------------
const actual = {
  kept: banks.length,
  active: banks.filter((b) => b.status === "active").length,
  merged: banks.filter((b) => b.status === "merged").length,
  withNipCode: banks.filter((b) => b.nipCode).length,
  withCbnCode: banks.filter((b) => b.cbnCode).length,
  withUnverifiedCode: banks.filter((b) => b.unverified).length,
};
for (const [key, value] of Object.entries(actual)) {
  if (data.counts?.[key] !== value) {
    fail(`counts.${key} says ${data.counts?.[key]} but the data contains ${value}`);
  }
}

// --- sorted, so diffs stay readable ------------------------------------------
const sortedIds = [...banks.map((b) => b.id)].sort((a, b) => a.localeCompare(b));
if (JSON.stringify(banks.map((b) => b.id)) !== JSON.stringify(sortedIds)) {
  fail("banks are not sorted by id, which makes every regeneration a noisy diff");
}

// --- package copies are byte-identical --------------------------------------
// Each package ships its own copy so the published artifacts need no runtime
// dependency on naija-data. If a copy drifts, one language would resolve banks
// differently from the other, which the parity tests would not necessarily catch.
const canonical = readFileSync(FILE, "utf8");
for (const relative of [
  "packages/ts/src/data/banks.json",
  "packages/python/src/naija_pay/_data/banks.json",
]) {
  const target = path.join(ROOT, relative);
  let copy;
  try {
    copy = readFileSync(target, "utf8");
  } catch {
    fail(`${relative} is missing; run \`npm run build:banks\``);
    continue;
  }
  if (copy !== canonical) {
    fail(`${relative} differs from data/banks.generated.json; run \`npm run build:banks\``);
  }
}

if (failed) process.exit(1);

console.log(
  `ok    bank data valid: ${actual.kept} institutions ` +
    `(${actual.active} active, ${actual.merged} merged), ` +
    `${actual.withNipCode} with NIP code, ${actual.withCbnCode} with CBN code, ` +
    `naija-data ${data.source.dataVersion}`,
);
