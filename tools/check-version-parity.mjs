#!/usr/bin/env node
/**
 * The TypeScript and Python packages must always declare the same version, and both
 * must match the version their source code exports. Shipping 0.3.1 on npm and 0.3.0
 * on PyPI would make every "same concepts, same naming" promise in the README a lie,
 * so CI checks it from the first commit.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(root, p), "utf8");

const found = {
  "packages/ts/package.json": JSON.parse(read("packages/ts/package.json")).version,
  "packages/ts/src/index.ts": read("packages/ts/src/index.ts").match(
    /export const VERSION = "([^"]+)"/,
  )?.[1],
  "packages/python/pyproject.toml": read("packages/python/pyproject.toml").match(
    /^version\s*=\s*"([^"]+)"/m,
  )?.[1],
  "packages/python/src/naija_pay/__init__.py": read(
    "packages/python/src/naija_pay/__init__.py",
  ).match(/^__version__ = "([^"]+)"/m)?.[1],
};

const missing = Object.entries(found).filter(([, v]) => !v);
if (missing.length > 0) {
  console.error("could not read a version from:");
  for (const [file] of missing) console.error(`  ${file}`);
  process.exit(1);
}

const versions = new Set(Object.values(found));
if (versions.size !== 1) {
  console.error("version mismatch between the packages:");
  for (const [file, v] of Object.entries(found)) console.error(`  ${v}  ${file}`);
  process.exit(1);
}

console.log(`version parity ok: ${[...versions][0]} in all 4 places`);
