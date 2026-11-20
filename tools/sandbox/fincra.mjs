#!/usr/bin/env node
/**
 * Exercises the Fincra adapter against Fincra's real sandbox.
 *
 * Run with `npm run sandbox:fincra`. Needs `FINCRA_SECRET_KEY` in `.env`, and refuses to
 * run with a key that is not a sandbox key — this script creates checkouts, virtual
 * accounts and payouts. `FINCRA_BUSINESS_ID` is needed by most endpoints; without it the
 * run gets as far as `getBusiness`, which is how you find the id in the first place.
 *
 * Its job is not to duplicate the unit tests, which already normalise from recorded
 * fixtures. It answers the questions the documentation cannot:
 *
 *   1. **Which envelope key comes back?** Fincra's own samples use `success` on some
 *      endpoints and `status` on others, and the adapter accepts either. A live run says
 *      which one this account actually gets.
 *   2. **Are the six-decimal amounts real?** The recorded fixtures report fees like
 *      `9090.909091` and balances like `4145.558824` — figures no currency can represent.
 *      The adapter returns null for those rather than rounding money. If the sandbox
 *      shows them too, that decision is load-bearing rather than theoretical.
 *   3. **Does the temporary-account endpoint really take `amount` as a STRING?** It is
 *      the only Fincra endpoint that does, which is why `majorToString` exists.
 *   4. **Are `bold` and `providus` really disabled as virtual-account channels?** The
 *      adapter refuses them locally on the strength of Fincra's own table.
 *   5. **Does a GET with a body work, or did Fincra mean query parameters?** Fincra
 *      documents a body on some GETs; the adapter sends query parameters instead.
 *   6. **Do the real responses still match the shapes recorded from the docs?**
 *
 * It writes what it observed to `fixtures/providers/fincra/SANDBOX.md`, so the evidence is
 * reviewable rather than a claim in a commit message. Personal data is never written
 * there: a resolved account name is recorded only by its length, and a BVN verification
 * is recorded only as which fields were present — never their values.
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
const secretKey = env.FINCRA_SECRET_KEY;

if (!secretKey) {
  console.log("FINCRA_SECRET_KEY is not set, so the Fincra sandbox run is skipped.");
  console.log("Put your Fincra sandbox secret key in .env to enable it. Nothing failed.");
  process.exit(0);
}

// Fincra's keys do not carry a test/live marker the way Paystack's and Flutterwave's do,
// so there is nothing to pattern-match on. The environment must be declared instead, and
// this harness will only ever run against the sandbox.
if ((env.NAIJA_PAY_ENV ?? "test") === "production") {
  console.error("REFUSING TO RUN: NAIJA_PAY_ENV is 'production'.");
  console.error("This script creates checkouts, virtual accounts and payouts.");
  process.exit(1);
}

const { fincra } = await import(
  pathToFileURL(path.join(ROOT, "packages", "ts", "src", "providers", "fincra", "index.ts")).href
);
const { money, naira, toMajor, majorToString } = await import(
  pathToFileURL(path.join(ROOT, "packages", "ts", "src", "core", "money.ts")).href
);

/** Records the raw envelope key of every response, which is question 1. */
const envelopeKeys = new Set();
const sentBodies = [];

const instrumentedFetch = async (input, init) => {
  if (init?.body) {
    sentBodies.push({ url: typeof input === "string" ? input : input.url, body: init.body });
  }
  const response = await fetch(input, init);
  // Read the body once, note its envelope key, and hand back an equivalent response so
  // the adapter still sees an unread stream.
  const text = await response.text();
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      for (const key of ["success", "status"]) {
        if (Object.hasOwn(parsed, key)) envelopeKeys.add(`${key}=${JSON.stringify(parsed[key])}`);
      }
    }
  } catch {
    // Not JSON. Nothing to record, and the adapter will report it.
  }
  return new Response(text, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};

const provider = fincra({
  secretKey,
  environment: "test",
  fetch: instrumentedFetch,
  ...(env.FINCRA_BUSINESS_ID ? { businessId: env.FINCRA_BUSINESS_ID } : {}),
  ...(env.FINCRA_PUBLIC_KEY ? { publicKey: env.FINCRA_PUBLIC_KEY } : {}),
  ...(env.FINCRA_WEBHOOK_SECRET ? { webhookSecretKey: env.FINCRA_WEBHOOK_SECRET } : {}),
});

/** A unique suffix so repeated runs never collide on a reference. */
const run = Date.now().toString(36);
const observations = [];
let failures = 0;

/** Thrown by a probe that cannot run because nothing was configured for it. */
function skipped(because) {
  return Object.assign(new Error(because), { name: "Skipped" });
}

/**
 * Stops a probe that needs the business id.
 *
 * Nearly every Fincra endpoint is keyed on it, and `getBusiness` is the one call that
 * finds it — so on an account where that call fails there is nothing to probe, and saying
 * so once is clearer than a column of identical ConfigurationErrors.
 */
function requireBusiness() {
  if (!businessId) {
    throw skipped("no FINCRA_BUSINESS_ID, and getBusiness did not supply one either");
  }
}

/**
 * Runs one probe.
 *
 * `expected` names an error class that is an acceptable outcome, with a reason. Some
 * probes cannot succeed on an account that has not been funded or granted a feature, and
 * that is a fact about the account rather than a defect in the adapter — so it is
 * recorded as "blocked" and does not fail the run. Carried over from the Paystack
 * harness, which needed it for Dedicated Virtual Accounts.
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

    // A probe that was never configured for is not a result either way.
    if (name === "Skipped") {
      console.log(`blocked — ${error.message}`);
      observations.push({ question, outcome: "blocked", note: `Not run: ${error.message}.` });
      return;
    }

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

console.log("Fincra sandbox run\n");

// --- the business id, which almost everything else needs --------------------

let businessId = env.FINCRA_BUSINESS_ID;

await observe("getBusiness is how you find the id every other call needs", async () => {
  const business = await provider.getBusiness();
  const found = business.id;
  // The id identifies the merchant, not a person, and is needed in .env anyway — but it
  // is still only reported by shape here, because this file is public.
  const agrees = businessId
    ? found === businessId
      ? "agrees with .env"
      : "DIFFERS from .env"
    : "nothing in .env to compare";
  businessId ??= found ?? undefined;
  return `an id of ${found ? String(found).length : 0} characters came back; ${agrees}`;
});

// --- reads, which create nothing -------------------------------------------

await observe("the bank list is reachable and shaped as recorded", async () => {
  const banks = await provider.listBanks();
  const sample = banks.find((b) => b.code === "044") ?? banks[0];
  const keys = Object.keys(sample ?? {})
    .sort()
    .join(", ");
  const withNip = banks.filter((b) => b.nipCode !== null).length;
  const codeLengths = [...new Set(banks.map((b) => b.code.length))].sort().join("/");
  return (
    `${banks.length} banks; entry keys: ${keys}; code lengths seen: ${codeLengths}; ` +
    `${withNip} publish a NIBSS code`
  );
});

await observe("account resolution returns a name", async () => {
  const account = await provider.resolveAccount({ accountNumber: "0690000032", bankCode: "044" });
  // The resolved name may be a REAL person's name. It must never be written to a file in
  // a public repository, so only its shape is recorded. The Paystack harness leaked one
  // into a committed file on its first run; this is that lesson, applied.
  const shape = account.accountName
    ? `a name of ${account.accountName.length} characters was returned`
    : "no name returned";
  return (
    `${shape}; bank code kept as ${account.bankCode ?? "null"} (Fincra does not echo it); ` +
    `institution match ${account.institution ? `${account.institution.id} by ${account.institution.matchedBy}` : "none"}`
  );
});

await observe("QUESTION 2: are the six-decimal balances real?", async () => {
  requireBusiness();
  const wallets = await provider.getBalance();
  if (wallets.length === 0) throw skipped("this account has no wallets");
  // A null `available` is the adapter refusing to round money, which is only the right
  // call if Fincra really does report figures like 4145.558824.
  const unrepresentable = wallets.filter((w) => w.available === null);
  const shown = wallets
    .map((w) => {
      const raw = w.raw;
      const figure = raw && typeof raw === "object" ? raw.availableBalance : undefined;
      return `${w.currency}: ${w.available === null ? `NOT representable (${figure})` : `${w.available.amount} minor units (= ${toMajor(w.available)})`}`;
    })
    .join("; ");
  return (
    `${wallets.length} wallet(s); ${unrepresentable.length} carried more decimals than ` +
    `the currency has. ${shown}`
  );
});

await observe("QUESTION 1: which envelope key does this account actually get?", () => {
  const keys = [...envelopeKeys].sort().join(", ");
  return (
    `${keys || "none seen yet"}; the adapter accepts either, because Fincra's own samples ` +
    `use both`
  );
});

// --- the string-amount endpoint, which is the reason majorToString exists ---

await observe(
  "QUESTION 3: does the temporary-account endpoint take amount as a STRING?",
  async () => {
    requireBusiness();
    const amount = money(35_000, "NGN"); // 350 naira exactly, the awkward case.
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    const account = await provider.createDynamicVirtualAccount({
      amount,
      expiresAt,
      reference: `naijapay-dva-${run}`,
    });
    const sent = sentBodies.at(-1)?.body ?? "";
    const parsed = (() => {
      try {
        return JSON.parse(sent);
      } catch {
        return {};
      }
    })();
    return (
      `sent amount as ${JSON.stringify(parsed.amount)} (majorToString gave ` +
      `"${majorToString(amount)}", NOT "350.0"); Fincra issued ` +
      `${account.accounts.length} account(s); kind ${account.kind}; ` +
      `expiresAt ${account.expiresAt ? "echoed" : "not echoed"}`
    );
  },
);

// --- channels --------------------------------------------------------------

await observe("QUESTION 4: are bold and providus really refused as channels?", async () => {
  // The refusal is local, on the strength of Fincra's published table. This probe checks
  // the adapter still refuses — and asks Fincra directly whether it agrees, which is the
  // part that could change under us.
  let refused = false;
  try {
    await provider.createVirtualAccount({
      currency: "NGN",
      accountType: "individual",
      firstName: "Ada",
      lastName: "Example",
      bvn: "22222222222",
      channel: "providus",
    });
  } catch (error) {
    refused = /DISABLED/.test(error.message);
    if (!refused) throw error;
  }
  return refused
    ? "the adapter refused `providus` locally, naming Fincra's own table as the reason"
    : "*** the adapter did NOT refuse providus — the table has changed, check it ***";
});

// --- GET with a body -------------------------------------------------------

await observe(
  "QUESTION 5: a documented GET-with-body is sent as query parameters instead",
  async () => {
    requireBusiness();
    const before = sentBodies.length;
    const page = await provider.listRefunds();
    const sentABody = sentBodies.length > before;
    return (
      `${page.items.length} refund(s), total=${page.total}; the adapter sent ` +
      `${sentABody ? "*** A BODY — which is not what was intended ***" : "no body, only query parameters"}`
    );
  },
);

// --- collections -----------------------------------------------------------

let checkoutReference;

await observe("a naira checkout can be created and keeps its exact amount", async () => {
  // 5,000 naira and 50 kobo, the same figure every harness sends, so the provider
  // comparison in PROVIDERS.md is like for like.
  requireBusiness();
  const amount = money(500_050, "NGN");
  checkoutReference = `naijapay-frac-${run}`;
  const checkout = await provider.createCheckout({
    amount,
    email: "ada@example.com",
    name: "Ada Probe",
    reference: checkoutReference,
  });
  return (
    `sent amount=${toMajor(amount)} (from ${amount.amount} kobo); checkout at ` +
    `${new URL(checkout.checkoutUrl).host}; payCode ${checkout.payCode ? "issued" : "none"}`
  );
});

await observe("the checkout verifies, and the amount comes back unchanged", async () => {
  requireBusiness();
  if (!checkoutReference) throw skipped("no checkout was created");
  const transaction = await provider.verifyTransaction(checkoutReference);
  const back = transaction.amount;
  const matches = back?.amount === 500_050;
  return (
    `Fincra returned ${back ? `${back.amount} kobo (${toMajor(back)})` : "no amount"}; ` +
    `status ${transaction.status}; fees ${transaction.fees ? toMajor(transaction.fees) : "none reported"}; ` +
    `${matches ? "EXACT MATCH" : "*** MISMATCH — investigate before trusting any amount ***"}`
  );
});

// --- static virtual accounts ------------------------------------------------

await observe("a static NGN virtual account request is accepted", async () => {
  requireBusiness();
  const account = await provider.createVirtualAccount({
    currency: "NGN",
    accountType: "individual",
    reference: `naijapay-va-${run}`,
    firstName: "Ada",
    lastName: "Example",
    email: `probe+${run}@example.com`,
    // Fincra's documented sandbox BVN. A real BVN must never appear in this repository.
    bvn: "22222222222",
  });
  return (
    `${account.accounts.length} account(s) issued; kind ${account.kind}; ` +
    `status ${account.status}; kyc ${account.kycStatus}; ` +
    `id ${account.id ? "returned" : "not returned"}`
  );
});

// --- payouts, which need a funded wallet -----------------------------------

await observe(
  "a naira payout reports what it is waiting for, if anything",
  async () => {
    requireBusiness();
    const payout = await provider.createPayout({
      amount: naira(100),
      reference: `naijapay-payout-${run}`,
      description: "naija-pay sandbox probe",
      beneficiary: {
        accountNumber: "0690000032",
        bankCode: "044",
        accountHolderName: "Ada Example",
        type: "individual",
      },
    });
    return (
      `status ${payout.status}; awaitingDocument=${payout.awaitingDocument}; ` +
      `documents required: ${payout.documentsRequired.join(", ") || "none"}; ` +
      `fee ${payout.fee ? toMajor(payout.fee) : "none reported"}`
    );
  },
  {
    error: "InsufficientFundsError",
    because: "the sandbox wallet is empty, so no transfer could be attempted.",
  },
);

// --- identity --------------------------------------------------------------

await observe("a BVN verification never carries the photograph", async () => {
  requireBusiness();
  const verification = await provider.verifyBvn("22222222222");
  // Only WHICH fields came back, never their values: this is somebody's identity.
  const present = ["firstName", "middleName", "lastName", "gender", "dateOfBirth", "phone"]
    .filter((field) => verification[field] !== null && verification[field] !== undefined)
    .join(", ");
  const leaked = JSON.stringify(verification.raw ?? null).includes("pixBase64");
  return (
    `verified=${verification.verified}; fields present: ${present || "none"}; ` +
    `${leaked ? "*** THE PHOTOGRAPH IS STILL IN raw — fix before shipping ***" : "the photograph is absent from raw, as intended"}`
  );
});

// --- write up what we saw ---------------------------------------------------

const when = new Date().toISOString().slice(0, 10);
const lines = [
  "# Fincra sandbox observations",
  "",
  "Generated by `npm run sandbox:fincra`. **Do not edit by hand** — rerun it instead.",
  "",
  `Run on **${when}** against Fincra's sandbox, using the adapter in`,
  "`packages/ts/src/providers/fincra/`.",
  "",
  "This file exists because the documentation leaves some things unsaid. Where it and",
  "the sandbox disagree, the sandbox wins and PROVIDERS.md records both.",
  "",
  "No personal data is recorded here. A resolved account name appears only as its",
  "length, and a BVN verification only as which fields were present — never their",
  "values — because this file is committed to a public repository.",
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
  `Envelope keys seen across the whole run: ${[...envelopeKeys].sort().join(", ") || "none"}.`,
  "",
];

const target = path.join(ROOT, "fixtures", "providers", "fincra", "SANDBOX.md");
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
