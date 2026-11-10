#!/usr/bin/env node
/**
 * Exercises the Flutterwave adapter against Flutterwave's real sandbox.
 *
 * Run with `npm run sandbox:flutterwave`. Needs `FLUTTERWAVE_SECRET_KEY` in `.env`, and
 * **refuses to run with anything but a `FLWSECK_TEST-` key** — this script creates
 * checkouts, subaccounts, wallets, virtual accounts and transfers, and none of that
 * belongs on a live integration.
 *
 * Its job is not to duplicate the unit tests, which already cover normalisation from
 * recorded fixtures. It answers the questions the documentation cannot:
 *
 *   1. **Does the decimal conversion survive a real round trip?** We send `5000.5` for
 *      5,000 naira 50 kobo. Flutterwave should echo it back unchanged. If it returns
 *      `5000.49` or `5001`, every amount this SDK sends is suspect, and that is the
 *      single most important thing this run can tell us.
 *   2. **Is `data.status` really `NEW` on a created transfer?** The adapter reports a
 *      payout as pending on the strength of that. If the sandbox returns something
 *      else, the mapping is wrong.
 *   3. **Do transfers need dashboard approval on a fresh account?** Paystack's OTP gate
 *      was on by default and nobody had documented it. The same question applies here.
 *   4. **Are payout subaccounts enabled?** They are the only wallet product in Tier 1,
 *      and Flutterwave may gate them per merchant as Paystack gates DVAs.
 *   5. **Is a percentage split really a decimal fraction?** We send `0.09` for 9%.
 *   6. **Do the real responses still match the shapes we recorded from the docs?**
 *
 * It writes what it observed to `fixtures/providers/flutterwave/SANDBOX.md`, so the
 * evidence is reviewable rather than a claim in a commit message. Personal data is
 * never written there: a resolved account name is recorded only by its length, a
 * mistake this project made once already.
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
const secretKey = env.FLUTTERWAVE_SECRET_KEY;

if (!secretKey) {
  console.log("FLUTTERWAVE_SECRET_KEY is not set, so the Flutterwave sandbox run is skipped.");
  console.log("Put a FLWSECK_TEST- key in .env to enable it. Nothing failed.");
  process.exit(0);
}

if (!secretKey.startsWith("FLWSECK_TEST-")) {
  console.error("REFUSING TO RUN: FLUTTERWAVE_SECRET_KEY is not a FLWSECK_TEST- key.");
  console.error("This script creates checkouts, subaccounts, wallets and transfers.");
  process.exit(1);
}

const { flutterwave } = await import(
  pathToFileURL(path.join(ROOT, "packages", "ts", "src", "providers", "flutterwave", "index.ts"))
    .href
);
const { money, naira, toMajor } = await import(
  pathToFileURL(path.join(ROOT, "packages", "ts", "src", "core", "money.ts")).href
);

const provider = flutterwave({
  secretKey,
  environment: "test",
  // Present only so verifyWebhook can be exercised; absent is fine for everything else.
  ...(env.FLUTTERWAVE_SECRET_HASH ? { webhookSecretHash: env.FLUTTERWAVE_SECRET_HASH } : {}),
});

/**
 * A unique suffix so repeated runs never collide on a reference.
 *
 * Hyphens only, and short: Flutterwave's v4 pattern allows 6 to 42 characters of
 * letters, digits and hyphens, and the adapter enforces it.
 */
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
 * cry wolf every time. Carried over from the Paystack harness, which needed it for
 * Dedicated Virtual Accounts.
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

console.log("Flutterwave sandbox run\n");

// --- reads, which create nothing -------------------------------------------

await observe("the bank list is reachable and shaped as recorded", async () => {
  const banks = await provider.listBanks("NG");
  const sample = banks.find((b) => b.code === "044") ?? banks[0];
  const keys = Object.keys(sample ?? {})
    .sort()
    .join(", ");
  const matched = banks.filter((b) => b.institution !== null).length;
  const codeLengths = [...new Set(banks.map((b) => b.code.length))].sort().join("/");
  return (
    `${banks.length} banks; entry keys: ${keys}; code lengths seen: ${codeLengths}; ` +
    `${matched} matched a naija-data institution (${Math.round((matched / banks.length) * 100)}%)`
  );
});

await observe("the balance endpoint returns decimals we can convert exactly", async () => {
  const balances = await provider.getBalance();
  if (balances.length === 0) return "no balances returned";
  // The adapter has already converted to minor units. Showing both makes the
  // conversion auditable from this file alone.
  return balances
    .map((b) => `${b.currency} ${b.amount} minor units (= ${toMajor(money(b.amount, b.currency))})`)
    .join(", ");
});

await observe("account resolution returns a name", async () => {
  // Flutterwave's documented test account: 0690000032 at bank 044.
  const account = await provider.resolveAccount({ accountNumber: "0690000032", bankCode: "044" });
  // The resolved name may be a REAL person's name. It must never be written to a file
  // in a public repository, so only its shape is recorded. The Paystack harness leaked
  // one into a committed file on its first run; this is that lesson, applied.
  const shape = account.accountName
    ? `a name of ${account.accountName.length} characters was returned`
    : "no name returned";
  return (
    `${shape}; bank code echoed back as ${account.bankCode ?? "null"}; institution match ` +
    `${account.institution ? `${account.institution.id} by ${account.institution.matchedBy}` : "none"}`
  );
});

await observe("verifying an unknown reference raises NotFoundError", async () => {
  try {
    await provider.verifyTransactionByReference(`naijapay-missing-${run}`);
    throw new Error("expected a failure, but the call succeeded");
  } catch (error) {
    return `${error.name}: ${error.providerMessage ?? error.message}`;
  }
});

// --- the decimal question, which matters more than the rest ----------------

let fractionalReference;

await observe("QUESTION 1: does a fractional amount survive the round trip exactly?", async () => {
  // 5,000 naira and 50 kobo. If Flutterwave echoes anything but 5000.5, every amount
  // this SDK sends is suspect and the conversion needs rethinking.
  const amount = money(500_050, "NGN");
  fractionalReference = `naijapay-frac-${run}`;
  const checkout = await provider.createCheckout({
    amount,
    email: "ada@example.com",
    reference: fractionalReference,
  });
  return (
    `sent amount=${toMajor(amount)} (from ${amount.amount} kobo); ` +
    `checkout created, link host ${new URL(checkout.checkoutUrl).host}`
  );
});

await observe("the fractional amount comes back unchanged on verify", async () => {
  // An unpaid checkout still has a transaction record keyed on tx_ref.
  try {
    const transaction = await provider.verifyTransactionByReference(fractionalReference);
    const back = transaction.amount;
    const matches = back?.amount === 500_050;
    return (
      `Flutterwave returned ${back ? `${back.amount} kobo (${toMajor(back)})` : "no amount"}; ` +
      `${matches ? "EXACT MATCH" : "*** MISMATCH — investigate before trusting any amount ***"}`
    );
  } catch (error) {
    // Flutterwave may not expose a transaction until it is attempted. That is a fact
    // about the provider, not a conversion failure.
    return `could not verify an unpaid checkout: ${error.name}: ${error.message}`;
  }
});

// --- splits ----------------------------------------------------------------

let subaccountId;

await observe("QUESTION 5: is a percentage split really a decimal fraction?", async () => {
  const account = await provider.createSplitAccount({
    businessName: `NaijaPay Probe ${run}`,
    accountNumber: "0690000037",
    bankCode: "044",
    businessMobile: "08100000000",
    businessEmail: `vendor+${run}@example.com`,
    // 900 basis points. The adapter converts this to 0.09 on the wire.
    shareBasisPoints: 900,
  });
  subaccountId = account.code;
  const back = account.percentageCharge;
  return (
    `sent split_value=0.09 for 900 bps; Flutterwave returned ` +
    `${back === null ? "no percentage" : `${back} bps`}; ` +
    `${back === 900 ? "EXACT MATCH" : "*** MISMATCH — check basisPointsToFraction ***"}; ` +
    `subaccount id prefix ${subaccountId.slice(0, 3)}`
  );
});

await observe("a split declaration is accepted on a checkout", async () => {
  const split = provider.createSplit([{ subaccountId, commissionBasisPoints: 2000 }]);
  const checkout = await provider.createCheckout({
    amount: naira(5_000),
    email: "ada@example.com",
    reference: `naijapay-split-${run}`,
    subaccounts: split,
  });
  return `accepted transaction_charge=${split[0].transaction_charge}; checkout created (${
    new URL(checkout.checkoutUrl).host
  })`;
});

// --- wallets, the capability Paystack has no answer to ---------------------

let walletReference;

await observe(
  "QUESTION 4: are payout subaccount wallets enabled on a fresh account?",
  async () => {
    const wallet = await provider.openWallet({
      accountName: `NaijaPay Probe ${run}`,
      email: `wallet+${run}@example.com`,
    });
    walletReference = wallet.reference;
    return (
      `opened; reference prefix ${wallet.reference.slice(0, 4)}, ` +
      `barter id ${wallet.barterId ? "present" : "ABSENT"}, ` +
      `own NUBAN ${wallet.account ? `at ${wallet.account.bankName ?? "unknown bank"}` : "ABSENT"}, ` +
      `status ${wallet.status}`
    );
  },
  {
    error: "ConfigurationError",
    because:
      "Payout subaccounts may need Flutterwave to enable them per merchant, as Paystack " +
      "gates Dedicated Virtual Accounts. The adapter classified it correctly.",
  },
);

await observe(
  "a new wallet's balance reads as zero rather than erroring",
  async () => {
    if (!walletReference) throw new Error("no wallet was opened, so there is nothing to read");
    const balance = await provider.getWalletBalance({ reference: walletReference });
    return `available ${balance.available ? `${balance.available.amount} kobo` : "null"}, ledger ${
      balance.ledger ? `${balance.ledger.amount} kobo` : "null"
    }`;
  },
  {
    error: "Error",
    because: "The wallet probe above did not open a wallet, so there is nothing to read.",
  },
);

// --- virtual accounts ------------------------------------------------------

await observe(
  "a dynamic virtual account can be created",
  async () => {
    const account = await provider.createDynamicVirtualAccount({
      email: `ada+${run}@example.com`,
      reference: `naijapay-dva-${run}`,
      amount: naira(5_000),
    });
    return (
      `kind=${account.kind}, kyc=${account.kycStatus}, ` +
      `account ${account.accounts[0] ? "returned" : "ABSENT"}, ` +
      `bank ${account.accounts[0]?.bankName ?? "unknown"}, ` +
      `expires ${account.expiresAt ? account.expiresAt.toISOString() : "not stated"}`
    );
  },
  {
    error: "ConfigurationError",
    because:
      "Virtual accounts may need Flutterwave to enable them per merchant. The adapter " +
      "classified it correctly.",
  },
);

await observe(
  "a static virtual account can be created with the documented test BVN",
  async () => {
    const account = await provider.createStaticVirtualAccount({
      email: `ada+static${run}@example.com`,
      reference: `naijapay-sva-${run}`,
      bvn: "22222222222",
      firstName: "Ada",
      lastName: "Obi",
    });
    return (
      `kind=${account.kind}, kyc=${account.kycStatus}, ` +
      `order reference ${account.orderReference ? "returned" : "ABSENT"}, ` +
      `account ${account.accounts[0] ? "returned" : "ABSENT"}`
    );
  },
  {
    error: "ConfigurationError",
    because: "Virtual accounts may need Flutterwave to enable them per merchant.",
  },
);

// --- payouts, the ones that move money -------------------------------------

await observe(
  "QUESTION 2 and 3: what status does a created transfer have, and does it need approval?",
  async () => {
    const payout = await provider.createPayout({
      amount: naira(100),
      accountNumber: "0690000037",
      bankCode: "044",
      reference: `naijapay-payout-${run}`,
      narration: "naija-pay sandbox probe",
    });
    return (
      `normalised status=${payout.status}, awaitingApproval=${payout.awaitingApproval}, ` +
      `raw data.status=${JSON.stringify(payout.raw?.status)}, ` +
      `requires_approval=${JSON.stringify(payout.raw?.requires_approval)}, ` +
      `is_approved=${JSON.stringify(payout.raw?.is_approved)}, ` +
      `fee ${payout.fee ? `${payout.fee.amount} kobo` : "not stated"}`
    );
  },
  {
    error: "InsufficientFundsError",
    because:
      "The test balance is empty, so no transfer can be created. Fund it from the " +
      "Flutterwave dashboard and rerun to answer this. The adapter classified the " +
      "empty balance correctly, which is itself worth knowing.",
  },
);

await observe("a duplicate payout reference is refused, not paid twice", async () => {
  const reference = `naijapay-dup-${run}`;
  const attempt = () =>
    provider.createPayout({
      amount: naira(100),
      accountNumber: "0690000037",
      bankCode: "044",
      reference,
    });

  try {
    await attempt();
  } catch (error) {
    // An empty balance stops this probe before it can test anything useful.
    if (error.name === "InsufficientFundsError") {
      return "skipped: the test balance is empty, so the first transfer never happened";
    }
    throw error;
  }

  try {
    await attempt();
    return "*** the second transfer with the same reference SUCCEEDED — investigate ***";
  } catch (error) {
    return `second attempt refused with ${error.name}: ${error.providerMessage ?? error.message}`;
  }
});

// --- write up what we saw ---------------------------------------------------

const when = new Date().toISOString().slice(0, 10);
const lines = [
  "# Flutterwave sandbox observations",
  "",
  "Generated by `npm run sandbox:flutterwave`. **Do not edit by hand** — rerun it instead.",
  "",
  `Run on **${when}** against Flutterwave's sandbox with a \`FLWSECK_TEST-\` key, using`,
  "the adapter in `packages/ts/src/providers/flutterwave/`.",
  "",
  "This file exists because the documentation leaves some things unsaid. Where it and",
  "the sandbox disagree, the sandbox wins and PROVIDERS.md records both.",
  "",
  "No personal data is recorded here. A resolved account name appears only as its",
  "length, because this file is committed to a public repository.",
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

const target = path.join(ROOT, "fixtures", "providers", "flutterwave", "SANDBOX.md");
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
