#!/usr/bin/env node

/**
 * Cross-language parity.
 *
 * Runs the shared cases in `fixtures/parity/core.json` through both packages and
 * compares the canonical JSON they emit, byte for byte. If TypeScript and Python ever
 * disagree about what an amount is worth, how a split rounds, what a redacted string
 * looks like, or why a value was refused, this fails and names the case.
 *
 * Also checks that all four declared versions match, because shipping 0.3.1 on npm and
 * 0.3.0 on PyPI would make the README's "same concepts in both languages" promise false.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");

let failed = false;
const fail = (msg) => {
  console.error(`FAIL  ${msg}`);
  failed = true;
};

// ---------------------------------------------------------------- version parity

const versions = {
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

const missingVersions = Object.entries(versions).filter(([, v]) => !v);
if (missingVersions.length > 0) {
  for (const [file] of missingVersions) fail(`no version found in ${file}`);
} else if (new Set(Object.values(versions)).size !== 1) {
  fail("the packages declare different versions:");
  for (const [file, v] of Object.entries(versions)) console.error(`        ${v}  ${file}`);
} else {
  console.log(`ok    version parity: ${Object.values(versions)[0]} in all 4 places`);
}

// ------------------------------------------------------------------ core parity

function run(label, command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) {
    fail(`could not run the ${label} parity runner: ${result.error.message}`);
    return null;
  }
  if (result.status !== 0) {
    fail(`the ${label} parity runner exited ${result.status}`);
    if (result.stderr) console.error(result.stderr.trimEnd());
    return null;
  }
  // stderr must be empty too: a stray warning from inside the package is a defect we
  // want to see, not tolerate.
  if (result.stderr.trim() !== "") {
    fail(`the ${label} parity runner wrote to stderr:`);
    console.error(result.stderr.trimEnd());
    return null;
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    fail(`the ${label} parity runner did not emit valid JSON: ${error.message}`);
    console.error(result.stdout.slice(0, 2_000));
    return null;
  }
}

const ts = run("TypeScript", process.execPath, ["tools/parity/ts-runner.mjs"]);
const py = run("Python", process.platform === "win32" ? "python" : "python3", [
  "-I",
  "tools/parity/py_runner.py",
]);

if (ts && py) {
  const groups = [...new Set([...Object.keys(ts), ...Object.keys(py)])].sort();
  let cases = 0;
  let mismatches = 0;

  for (const group of groups) {
    const a = ts[group];
    const b = py[group];
    if (a === undefined) {
      fail(`group "${group}" is missing from the TypeScript runner`);
      continue;
    }
    if (b === undefined) {
      fail(`group "${group}" is missing from the Python runner`);
      continue;
    }
    if (a.length !== b.length) {
      fail(`group "${group}": TypeScript produced ${a.length} results, Python ${b.length}`);
      continue;
    }

    for (let i = 0; i < a.length; i++) {
      cases++;
      const left = JSON.stringify(a[i]);
      const right = JSON.stringify(b[i]);
      if (left !== right) {
        mismatches++;
        fail(`${group}[${i}] differs between languages`);
        console.error(`        TypeScript: ${left}`);
        console.error(`        Python:     ${right}`);
      }
    }
  }

  if (mismatches === 0) {
    console.log(`ok    core parity: ${cases} cases identical across ${groups.length} groups`);
  }
}

process.exit(failed ? 1 : 0);
