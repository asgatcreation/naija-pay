import { defineConfig } from "tsup";

/**
 * Builds ESM and CJS with type declarations.
 *
 * Each provider is its own entry point, so an application that imports only
 * `naija-pay/paystack` does not pull the other adapters into its bundle. That is the
 * whole reason the providers are not re-exported from the root.
 */
export default defineConfig({
  entry: {
    index: "src/index.ts",
    banks: "src/banks.ts",
    "providers/mock/index": "src/providers/mock/index.ts",
    "providers/paystack/index": "src/providers/paystack/index.ts",
  },
  format: ["esm", "cjs"],
  // Declarations come from `tsc -p tsconfig.build.json`, not from tsup: tsup 9 bundles
  // rollup-plugin-dts built against TypeScript 6, which crashes on TypeScript 7.
  dts: false,
  sourcemap: true,
  clean: true,
  // No runtime dependencies to externalise, and nothing should be bundled in from
  // node_modules — if that ever changes, the bundle-size report will say so loudly.
  treeshake: true,
  splitting: false,
  target: "es2023",
  outExtension({ format }) {
    return { js: format === "cjs" ? ".cjs" : ".js" };
  },
});
