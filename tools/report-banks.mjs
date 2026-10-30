#!/usr/bin/env node
/**
 * Reports how much of each provider's bank list can be matched to a naija-data
 * institution, and lists the ones that cannot.
 *
 * This is a reporting tool, not a gate. Unmatched banks are a naija-data issue to fix;
 * failing a build on a known upstream gap would just get the check disabled. See the
 * bank-codes section of DESIGN.md.
 *
 * Usage:
 *   node tools/report-banks.mjs                  # fetch the public provider lists
 *   node tools/report-banks.mjs --json           # machine-readable
 *
 * Only providers whose bank list is public and needs no key are fetched. The others are
 * reported once their adapters land and a sandbox key is available.
 */

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { coverageFor, bankDataSource } = await import(
  pathToFileURL(path.join(ROOT, "packages", "ts", "src", "core", "banks.ts")).href
);

const asJson = process.argv.includes("--json");

/** Public, keyless bank lists. Paystack's is open; most others need a key. */
const SOURCES = [
  {
    provider: "paystack",
    url: "https://api.paystack.co/bank?country=nigeria&perPage=1000",
    extract: (payload) =>
      (payload.data ?? []).map((bank) => ({ code: bank.code, name: bank.name })),
  },
];

const reports = [];

for (const source of SOURCES) {
  let banks;
  try {
    const response = await fetch(source.url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    banks = source.extract(await response.json());
  } catch (error) {
    reports.push({ provider: source.provider, error: String(error) });
    continue;
  }
  reports.push(coverageFor(source.provider, banks));
}

if (asJson) {
  console.log(JSON.stringify({ bankDataSource, reports }, null, 2));
  process.exit(0);
}

console.log(`naija-data ${bankDataSource.dataVersion} — ${bankDataSource.attribution}\n`);

for (const report of reports) {
  if (report.error) {
    console.log(`${report.provider}: could not fetch the bank list (${report.error})\n`);
    continue;
  }

  const percent = report.total === 0 ? 0 : ((report.matched / report.total) * 100).toFixed(1);
  console.log(`${report.provider}: ${report.matched} of ${report.total} matched (${percent}%)`);
  for (const [method, count] of Object.entries(report.byMethod)) {
    if (count > 0) console.log(`  by ${method.padEnd(9)} ${count}`);
  }

  if (report.unmatched.length > 0) {
    console.log(`  unmatched: ${report.unmatched.length}`);
    for (const bank of report.unmatched.slice(0, 15)) {
      console.log(`    ${String(bank.code ?? "").padStart(7)}  ${bank.name ?? ""}`);
    }
    if (report.unmatched.length > 15) {
      console.log(`    ... and ${report.unmatched.length - 15} more (use --json for all)`);
    }
  }
  console.log();
}

console.log(
  "Unmatched banks are not an error. The provider's own code stays authoritative;\n" +
    "these are candidates for a naija-data data-correction issue.",
);
