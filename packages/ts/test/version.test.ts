import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { VERSION } from "../src/index.ts";

test("VERSION matches the version declared in package.json", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  };

  assert.equal(VERSION, pkg.version);
});

test("the package declares no runtime dependencies", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    dependencies?: Record<string, string>;
  };

  assert.deepEqual(
    pkg.dependencies ?? {},
    {},
    "naija-pay must stay dependency-free at runtime; it uses fetch",
  );
});
