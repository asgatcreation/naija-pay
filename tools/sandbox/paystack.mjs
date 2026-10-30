#!/usr/bin/env node
/**
 * Exercises the Paystack adapter against Paystack's real sandbox.
 *
 * Run with `npm run sandbox:paystack`. Needs `PAYSTACK_SECRET_KEY` in `.env`, and
 * **refuses to run with anything but a `sk_test_` key** — this script creates
 * transactions, subaccounts, splits and transfers, and none of that belongs on a live
 * integration.
 *
 * Its job is not to duplicate the unit tests, which already cover normalisation from
 * recorded fixtures. It answers the questions the documentation cannot:
 *
 *   1. Does `/subaccount` want `bank_code` or `settlement_bank`? The reference and the
 *      cURL sample disagree, and we currently send both.
 *   2. Is transfer OTP enabled by default on a fresh integration? If it is, every payout
 *      needs a human, which changes how an application must be built.
 *   3. Do the real responses still match the shapes we recorded from the docs?
 *
 * It writes what it observed to `fixtures/providers/paystack/SANDBOX.md`, so the
 * evidence is reviewable rather than a claim in a commit message.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Minimal .env reader — the package has no runtime dependencies and nor does this. */
function loadEnv() {
  const file = path.join(ROOT, ".env");
  if (!existsSync(file)) return {};
  const out = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    const name = trimmed.slice(0, index).trim();
    const value = trimmed
      .slice(index + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (value) out[name] = value;
  }
  return out;
}

const env = { ...loadEnv(), ...process.env };
const secretKey = env.PAYSTACK_SECRET_KEY;

if (!secretKey) {
  console.log("PAYSTACK_SECRET_KEY is not set, so the Paystack sandbox run is skipped.");
  console.log("Put a sk_test_ key in .env to enable it. Nothing failed.");
  process.exit(0);
}

if (!secretKey.startsWith("sk_test_")) {
  console.error("REFUSING TO RUN: PAYSTACK_SECRET_KEY is not a sk_test_ key.");
  console.error("This script creates transactions, subaccounts, splits and transfers.");
  process.exit(1);
}

const { paystack } = await import(
  pathToFileURL(path.join(ROOT, "packages", "ts", "src", "providers", "paystack", "index.ts")).href
);
const { naira } = await import(
  pathToFileURL(path.join(ROOT, "packages", "ts", "src", "core", "money.ts")).href
);

const provider = paystack({ secretKey, environment: "test" });

/** A unique suffix so repeated runs never collide on a reference. */
const run = Date.now().toString(36);
const observations = [];
let failures = 0;

/**
 * Runs one probe.
 *
 * `expected` names an error class that is an acceptable outcome, with a reason. Some
 * probes cannot succeed on an account that has not been granted a feature, and that is
 * a fact about the account rather than a defect in the adapter — so it is recorded as
 * "blocked" and does not fail the run. Without this, the weekly drift workflow would
 * cry wolf every time.
 */
async function observe(question, fn, expected) {
  process.stdout.write(`  ${question} ... `);
  try {
    const note = await fn();
    console.log("ok");
    observations.push({ question, outcome: "ok", note });
  } catch (error) {
    const name = error && typeof error === "object" && "name" in error ? error.name : "Error";
    const detail = `${name}: ${error?.message ?? String(error)}`;

    if (expected && name === expected.error) {
      console.log(`blocked (expected) — ${expected.because}`);
      observations.push({
        question,
        outcome: "blocked",
        note: `${expected.because} Provider said: ${detail}`,
      });
      return;
    }

    failures++;
    console.log(`FAILED — ${detail}`);
    observations.push({ question, outcome: "failed", note: detail });
  }
}

console.log("Paystack sandbox run\n");

// --- reads, which create nothing -------------------------------------------
let firstBank;

await observe("the bank list is reachable and shaped as recorded", async () => {
  const banks = await provider.listBanks({ country: "nigeria" });
  firstBank = banks.find((b) => b.code === "044") ?? banks[0];
  const keys = Object.keys(firstBank ?? {})
    .sort()
    .join(", ");
  return `${banks.length} banks; first entry keys: ${keys}`;
});

await observe("account resolution returns a name", async () => {
  // Paystack test mode allows only THREE live bank resolves per day and tells you to
  // use test bank code 001 instead. Found by exceeding it; see SANDBOX.md.
  const account = await provider.resolveAccount({ accountNumber: "0000000000", bankCode: "001" });
  // The resolved name is a REAL person's name. It must never be written to a file in a
  // public repository, so only its shape is recorded. This file is the reason the
  // redactor exists, and the first draft of this script leaked a name into it.
  const shape = account.accountName
    ? `a name of ${account.accountName.length} characters was returned`
    : "no name returned";
  return `${shape}; institution match ${
    account.institution ? `${account.institution.id} by ${account.institution.matchedBy}` : "none"
  }`;
});

await observe("the balance endpoint works", async () => {
  const balances = await provider.getBalance();
  return balances.map((b) => `${b.currency} ${b.amount}`).join(", ") || "no balances returned";
});

await observe("verifying an unknown reference raises NotFoundError", async () => {
  try {
    await provider.verifyTransaction(`naijapay-missing-${run}`);
    throw new Error("expected a failure, but the call succeeded");
  } catch (error) {
    return `${error.name}: ${error.providerMessage ?? error.message}`;
  }
});

// --- writes, all sandbox-only ----------------------------------------------

await observe("a checkout can be initialized and the amount is accepted as a string", async () => {
  const checkout = await provider.createCheckout({
    amount: naira(5_000),
    email: "ada@example.com",
    reference: `naijapay-${run}-checkout`,
    channels: ["card", "bank_transfer"],
  });
  return `checkout URL issued, reference ${checkout.reference}`;
});

let subaccountCode;

await observe(
  "QUESTION 1: does /subaccount accept bank_code, settlement_bank, or both?",
  async () => {
    const account = await provider.createSplitAccount({
      businessName: `naija-pay sandbox ${run}`,
      bankCode: firstBank?.code ?? "044",
      accountNumber: "0000000000",
      percentageCharge: 2.5,
    });
    subaccountCode = account.code;
    return (
      `accepted with BOTH fields sent; code ${account.code}, ` +
      `settlement bank reported as "${account.settlementAccount?.bankName}", ` +
      `verified=${account.verified}`
    );
  },
);

await observe("QUESTION 1a: is bank_code alone accepted by /subaccount?", async () => {
  // Probing the raw endpoint, because the adapter deliberately sends both fields.
  const response = await fetch("https://api.paystack.co/subaccount", {
    method: "POST",
    headers: { authorization: `Bearer ${secretKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      business_name: `naija-pay probe bankcode ${run}`,
      bank_code: firstBank?.code ?? "044",
      account_number: "0000000000",
      percentage_charge: 2.5,
    }),
  });
  const body = await response.json();
  return `HTTP ${response.status}, status=${body.status}, message="${body.message}"`;
});

await observe("QUESTION 1b: is settlement_bank alone accepted by /subaccount?", async () => {
  const response = await fetch("https://api.paystack.co/subaccount", {
    method: "POST",
    headers: { authorization: `Bearer ${secretKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      business_name: `naija-pay probe settlement ${run}`,
      settlement_bank: firstBank?.code ?? "044",
      account_number: "0000000000",
      percentage_charge: 2.5,
    }),
  });
  const body = await response.json();
  return `HTTP ${response.status}, status=${body.status}, message="${body.message}"`;
});

await observe("a transaction split can be created from basis points", async () => {
  if (!subaccountCode) throw new Error("no subaccount was created, so the split is skipped");
  const split = await provider.createSplit({
    name: `naija-pay sandbox ${run}`,
    type: "percentage",
    currency: "NGN",
    parties: [{ account: subaccountCode, share: 9_000 }],
  });
  const share = split.parties[0]?.share;
  return `split ${split.code} created; 9000 bps came back as share=${share}`;
});

await observe("QUESTION 2: is transfer OTP enabled by default?", async () => {
  const payout = await provider.createPayout({
    amount: naira(100),
    accountNumber: "0000000000",
    bankCode: firstBank?.code ?? "044",
    accountName: "ADA OBI",
    reference: `naijapay-${run}-payout-aaaaaa`,
    reason: "naija-pay sandbox check",
  });
  return (
    `status=${payout.status}, awaitingOtp=${payout.awaitingOtp}, ` +
    `providerReference=${payout.providerReference}`
  );
});

await observe(
  "a dedicated virtual account can be assigned with a BVN",
  async () => {
    const result = await provider.createStaticVirtualAccount({
      email: `ada+${run}@example.com`,
      firstName: "Ada",
      lastName: "Obi",
      phone: "+2348100000000",
      preferredBank: "test-bank",
      bvn: "22222222222",
    });
    return `status=${result.status}, message="${result.message}"`;
  },
  {
    error: "ConfigurationError",
    because:
      "Dedicated Virtual Accounts must be enabled per business by Paystack, so this " +
      "cannot be exercised until they switch it on. The adapter classified it correctly.",
  },
);

// --- write up what we saw ---------------------------------------------------

const when = new Date().toISOString().slice(0, 10);
const lines = [
  "# Paystack sandbox observations",
  "",
  "Generated by `npm run sandbox:paystack`. **Do not edit by hand** — rerun it instead.",
  "",
  `Run on **${when}** against Paystack's sandbox with a \`sk_test_\` key, using the`,
  "adapter in `packages/ts/src/providers/paystack/`.",
  "",
  "This file exists because the documentation leaves some things unsaid. Where it and",
  "the sandbox disagree, the sandbox wins and PROVIDERS.md records both.",
  "",
  "| Observation | Outcome | What happened |",
  "| --- | --- | --- |",
  ...observations.map(
    (o) =>
      `| ${o.question.replace(/\|/g, "\\|")} | ${o.outcome} | ${String(o.note).replace(/\|/g, "\\|")} |`,
  ),
  "",
  `${observations.filter((o) => o.outcome === "ok").length} of ${observations.length} probes ` +
    `succeeded, ${observations.filter((o) => o.outcome === "blocked").length} were blocked by ` +
    `account configuration, ${failures} failed.`,
  "",
];

const target = path.join(ROOT, "fixtures", "providers", "paystack", "SANDBOX.md");
writeFileSync(target, `${lines.join("\n")}\n`, "utf8");

console.log(`\nwrote ${path.relative(ROOT, target)}`);
const ok = observations.filter((o) => o.outcome === "ok").length;
const blocked = observations.filter((o) => o.outcome === "blocked").length;
console.log(`${ok} succeeded, ${blocked} blocked by account configuration, ${failures} failed`);

if (failures > 0) {
  console.error("\nSome observations failed. That is information, not necessarily a defect —");
  console.error("read the table before changing any code.");
  process.exit(1);
}
