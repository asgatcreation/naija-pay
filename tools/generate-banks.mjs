#!/usr/bin/env node
/**
 * Generates `data/banks.generated.json` from naija-data's `data/banks.csv`.
 *
 * Runs at build time, and the output is committed, so the published packages carry
 * the data with no runtime dependency on naija-data.
 *
 * Usage:
 *   node tools/generate-banks.mjs              # fetch the current naija-data CSV
 *   node tools/generate-banks.mjs path/to.csv  # use a local copy (offline, CI)
 *
 * naija-data's dataset is CC BY 4.0, so the attribution it requires is embedded in
 * the generated file and must stay there.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CSV_URL =
  "https://raw.githubusercontent.com/asgatcreation/naija-data/main/data/banks.csv";
const META_URL =
  "https://raw.githubusercontent.com/asgatcreation/naija-data/main/packages/js/src/data/meta.json";
const OUT = path.join(ROOT, "data", "banks.generated.json");

/** Minimal RFC 4180 CSV parser: handles quoted fields and embedded commas. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else if (c !== "\r") {
      field += c;
    }
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);

  const [header, ...body] = rows;
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

const splitList = (s) => (s ? s.split("|").filter(Boolean) : []);

async function load() {
  const local = process.argv[2];
  if (local) {
    console.log(`reading ${local}`);
    return { csv: readFileSync(local, "utf8"), meta: null };
  }
  console.log(`fetching ${CSV_URL}`);
  const [csvRes, metaRes] = await Promise.all([fetch(CSV_URL), fetch(META_URL)]);
  if (!csvRes.ok) throw new Error(`could not fetch banks.csv: HTTP ${csvRes.status}`);
  return {
    csv: await csvRes.text(),
    meta: metaRes.ok ? await metaRes.json() : null,
  };
}

const { csv, meta } = await load();
const rows = parseCsv(csv);
if (rows.length < 100) throw new Error(`only ${rows.length} rows parsed; refusing to generate`);

// Institutions whose licence was revoked or which are defunct are dropped: nobody can
// be paid at one. Merged banks ARE kept, because providers still return their old
// codes and a caller needs to be told where the bank went.
const kept = rows.filter((r) => r.status === "active" || r.status === "merged");

const banks = kept
  .map((r) => {
    const bank = {
      id: r.id,
      name: r.name,
      type: r.type,
      status: r.status,
    };
    if (r.short_name) bank.shortName = r.short_name;
    if (r.cbn_code) bank.cbnCode = r.cbn_code;
    if (r.nip_code) bank.nipCode = r.nip_code;
    if (r.merged_into) bank.mergedInto = r.merged_into;
    const aliases = splitList(r.aliases);
    if (aliases.length) bank.aliases = aliases;
    // Codes naija-data has not been able to verify against a primary source. Carried
    // through so naija-pay can warn rather than quietly trust them.
    const unverified = splitList(r.unverified_fields)
      .map((f) => ({ cbn_code: "cbnCode", nip_code: "nipCode", ussd: "ussd" })[f])
      .filter((f) => f && f !== "ussd");
    if (unverified.length) bank.unverified = unverified;
    return bank;
  })
  .sort((a, b) => a.id.localeCompare(b.id));

// Codes must be unique among active banks, or a lookup by code is ambiguous and a
// payout could be routed to the wrong institution. Merged banks are excluded from this
// check because they legitimately share history with their acquirer.
const dupes = [];
for (const field of ["cbnCode", "nipCode"]) {
  const seen = new Map();
  for (const b of banks.filter((b) => b.status === "active" && b[field])) {
    const prev = seen.get(b[field]);
    if (prev) dupes.push(`${field} ${b[field]}: ${prev} and ${b.id}`);
    else seen.set(b[field], b.id);
  }
}
if (dupes.length > 0) {
  console.error("duplicate bank codes among active institutions:");
  for (const d of dupes) console.error(`  ${d}`);
  process.exit(1);
}

const out = {
  $comment:
    "GENERATED FILE - do not edit. Regenerate with `npm run build:banks`. Source data is naija-data, CC BY 4.0.",
  source: {
    repository: "https://github.com/asgatcreation/naija-data",
    file: "data/banks.csv",
    dataVersion: meta?.data_version ?? "unknown",
    licence: "CC-BY-4.0",
    attribution:
      "naija-data by Akanji Oluwaseun Gabriel (https://github.com/asgatcreation/naija-data), CC BY 4.0",
  },
  counts: {
    institutionsInSource: rows.length,
    kept: banks.length,
    active: banks.filter((b) => b.status === "active").length,
    merged: banks.filter((b) => b.status === "merged").length,
    withNipCode: banks.filter((b) => b.nipCode).length,
    withCbnCode: banks.filter((b) => b.cbnCode).length,
    withUnverifiedCode: banks.filter((b) => b.unverified).length,
  },
  banks,
};

mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`, "utf8");

const kb = (JSON.stringify(out).length / 1024).toFixed(1);
console.log(`wrote ${path.relative(ROOT, OUT)}`);
console.log(`  data version      ${out.source.dataVersion}`);
console.log(`  in source         ${out.counts.institutionsInSource}`);
console.log(`  kept              ${out.counts.kept} (${out.counts.active} active, ${out.counts.merged} merged)`);
console.log(`  with NIP code     ${out.counts.withNipCode}`);
console.log(`  with CBN code     ${out.counts.withCbnCode}`);
console.log(`  unverified codes  ${out.counts.withUnverifiedCode}`);
console.log(`  minified size     ${kb} KB`);
