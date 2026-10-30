#!/usr/bin/env node

/**
 * Reports the size of each published entry point, minified and gzipped.
 *
 * Run after `npm run build`. Sizes matter here because naija-pay is meant to run on
 * edge runtimes, where every kilobyte of a cold start is real, and because the bank
 * dataset is large enough to dominate any bundle that imports it.
 *
 * Fails if an entry point exceeds its budget, so a careless import cannot quietly
 * double the bundle.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "packages", "ts", "dist");

/**
 * Gzipped budgets, in kilobytes.
 *
 * The core is deliberately tight. The provider entry points carry the naija-data bank
 * registry for enrichment, which is the bulk of their weight — see the bank-codes
 * section of DESIGN.md for why that data is worth its size.
 */
const BUDGETS_KB = {
  // The core: money, errors, redaction, signatures, events, HTTP. No bank data.
  "index.js": 10,
  // The naija-data institution registry. Its own entry point precisely so that the
  // core stays small; see the comment at the top of src/banks.ts.
  "banks.js": 30,
  "providers/mock/index.js": 10,
  // Carries the bank registry for enrichment, which is most of its weight.
  "providers/paystack/index.js": 45,
};

if (!existsSync(DIST)) {
  console.error("no dist/ found — run `npm run build` first");
  process.exit(1);
}

let failed = false;
const rows = [];

for (const entry of Object.keys(BUDGETS_KB)) {
  const file = path.join(DIST, entry);
  if (!existsSync(file)) {
    console.error(`FAIL  ${entry} was not built`);
    failed = true;
    continue;
  }

  const raw = readFileSync(file);

  // Minify with esbuild, which tsup already depends on, so the number reflects what a
  // real bundler would ship rather than our unminified output.
  const minified = await build({
    entryPoints: [file],
    bundle: false,
    minify: true,
    write: false,
    format: "esm",
    target: "es2023",
  });
  const minifiedBytes = Buffer.from(minified.outputFiles[0].contents);
  const gzipped = gzipSync(minifiedBytes, { level: 9 });

  const kb = (bytes) => bytes.length / 1024;
  const budget = BUDGETS_KB[entry];
  const over = kb(gzipped) > budget;
  if (over) failed = true;

  rows.push({
    entry,
    raw: kb(raw),
    minified: kb(minifiedBytes),
    gzipped: kb(gzipped),
    budget,
    over,
  });
}

const pad = (text, width) => String(text).padEnd(width);
const num = (value) => value.toFixed(1).padStart(7);

console.log(
  `${pad("entry", 28)}${"raw".padStart(7)} ${"min".padStart(7)} ${"gzip".padStart(7)}  budget`,
);
for (const row of rows) {
  const flag = row.over ? "  OVER BUDGET" : "";
  console.log(
    `${pad(row.entry, 28)}${num(row.raw)} ${num(row.minified)} ${num(row.gzipped)}  ${String(
      row.budget,
    ).padStart(4)} KB${flag}`,
  );
}
console.log("\nSizes are KB. The budget applies to the gzipped, minified figure.");

if (failed) {
  console.error("\nAn entry point is over budget. Either trim it, or raise the budget");
  console.error("deliberately in tools/bundle-size.mjs with a note saying why.");
  process.exit(1);
}
