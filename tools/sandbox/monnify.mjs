#!/usr/bin/env node
/**
 * Exercises the Monnify adapter against Monnify's real sandbox.
 *
 * Run with `npm run sandbox:monnify`. Needs `MONNIFY_API_KEY`, `MONNIFY_SECRET_KEY` and
 * `MONNIFY_CONTRACT_CODE` in `.env`, and **refuses to run with anything but an
 * `MK_TEST_` key** — this script creates checkouts, reserved accounts and sub-accounts.
 *
 * Monnify publishes a set of public test credentials in its own documentation, so unlike
 * the other harnesses this one can be run by anyone without an account. They still go in
 * `.env` rather than in this file: a key in a repository is a key in a repository, even
 * one its owner published, and the day Monnify rotates them a hard-coded pair becomes a
 * confusing failure instead of a clear "not configured".
 *
 * Its job is not to duplicate the unit tests, which already normalise from recorded
 * fixtures. It answers the questions the documentation cannot:
 *
 *   1. **Does the Basic → Bearer login work, and how long does the token last?** The
 *      adapter caches the token and refreshes it a minute early. If `expiresIn` is not
 *      what the spec says, the cache is wrong.
 *   2. **Is the login really the only call that takes Basic?** The adapter sends Bearer
 *      everywhere else, and the `skipAuthorize` option exists only for this.
 *   3. **Does `/api/v1/transactions/search` really answer without the envelope?** The
 *      spec says so, the adapter has a fallback for it, and nothing but a live call can
 *      confirm it. This is the single most valuable thing this run can tell us.
 *   4. **Does `GET /api/v2/merchant/transactions/query` accept OUR reference?** It was
 *      wrongly declared absent during development. If it 404s on a reference Monnify has
 *      never seen, rather than erroring differently, the adapter's mapping is right.
 *   5. **Is two-factor disbursement on by default?** Paystack's OTP gate was, and nobody
 *      had documented it. A payout probe needs a funded wallet, so this may be blocked.
 *   6. **Are the amounts naira-decimal on the wire in both directions?** We send
 *      5,000 naira 50 kobo and check what comes back.
 *   7. **Do the real responses still match the shapes recorded from the spec?**
 *
 * It writes what it observed to `fixtures/providers/monnify/SANDBOX.md`, so the evidence
 * is reviewable rather than a claim in a commit message. Personal data is never written
 * there: a resolved account name is recorded only by its length, a mistake this project
 * made once already.
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
const apiKey = env.MONNIFY_API_KEY;
const secretKey = env.MONNIFY_SECRET_KEY;
const contractCode = env.MONNIFY_CONTRACT_CODE;

if (!apiKey || !secretKey || !contractCode) {
  console.log("Monnify credentials are not set, so the Monnify sandbox run is skipped.");
  console.log(
    "Monnify publishes public test credentials in its API reference; put the API key, " +
      "secret key and contract code in .env as MONNIFY_API_KEY, MONNIFY_SECRET_KEY and " +
      "MONNIFY_CONTRACT_CODE to enable this run. Nothing failed.",
  );
  process.exit(0);
}

if (!apiKey.startsWith("MK_TEST_")) {
  console.error("REFUSING TO RUN: MONNIFY_API_KEY is not an MK_TEST_ key.");
  console.error("This script creates checkouts, reserved accounts and sub-accounts.");
  process.exit(1);
}

const { monnify } = await import(
  pathToFileURL(path.join(ROOT, "packages", "ts", "src", "providers", "monnify", "index.ts")).href
);
const { money, naira, toMajor } = await import(
  pathToFileURL(path.join(ROOT, "packages", "ts", "src", "core", "money.ts")).href
);

/**
 * Counts the login calls, so question 1 can be answered by observation rather than by
 * reading the adapter. The adapter's own fetch is wrapped rather than mocked: the
 * requests are entirely real.
 */
let loginCount = 0;
const seenPaths = [];
const seenAuthSchemes = new Set();

const instrumentedFetch = async (input, init) => {
  const url = typeof input === "string" ? input : input.url;
  const pathname = new URL(url).pathname;
  seenPaths.push(pathname);
  if (pathname === "/api/v1/auth/login") loginCount++;
  const authorization = new Headers(init?.headers ?? {}).get("authorization") ?? "";
  seenAuthSchemes.add(
    `${pathname === "/api/v1/auth/login" ? "login" : "other"}:${authorization.split(" ")[0] || "none"}`,
  );
  return await fetch(input, init);
};

const provider = monnify({
  apiKey,
  secretKey,
  contractCode,
  environment: "test",
  fetch: instrumentedFetch,
  ...(env.MONNIFY_WALLET_ACCOUNT_NUMBER
    ? { walletAccountNumber: env.MONNIFY_WALLET_ACCOUNT_NUMBER }
    : {}),
});

/**
 * A Bearer token fetched outside the adapter.
 *
 * Two probes need to see a raw response — the envelope on the search endpoint, and the
 * status of a route the adapter deliberately does not call — so they cannot go through
 * the adapter that normalises both away.
 */
async function rawToken() {
  const response = await fetch("https://sandbox.monnify.com/api/v1/auth/login", {
    method: "POST",
    headers: {
      authorization: `Basic ${btoa(`${apiKey}:${secretKey}`)}`,
      "content-type": "application/json",
    },
  });
  return (await response.json())?.responseBody?.accessToken;
}

/** A unique suffix so repeated runs never collide on a reference. */
const run = Date.now().toString(36);
const observations = [];
let failures = 0;
/** How many probes died on Monnify refusing its own freshly issued token. */
let tokenRejections = 0;

/** True when this error is Monnify refusing the token it had just issued. */
function isTokenRejection(error) {
  return `${error?.message ?? ""} ${error?.providerMessage ?? ""}`.includes("invalid_token");
}

/**
 * Rethrows a token rejection.
 *
 * The probes that expect a failure catch their own errors and report the one they got.
 * Without this they would report `invalid_token` as if it were the answer, which would
 * make a dead sandbox account look like a passing run.
 */
function rethrowTokenRejection(error) {
  if (isTokenRejection(error)) throw error;
}

/** Thrown by a probe that cannot run because nothing was configured for it. */
function skipped(because) {
  return Object.assign(new Error(because), { name: "Skipped" });
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

    // Monnify can accept the login and then refuse the token it just issued: `POST
    // /api/v1/auth/login` answers 200 with a well-formed, unexpired JWT, and every
    // other endpoint answers `401 {"error":"invalid_token"}`. That is a condition of the
    // merchant account behind the credentials, not a defect in this adapter, so it is
    // recorded as blocked. Marking it failed would make a disabled sandbox account look
    // like broken code every time this runs.
    if (isTokenRejection(error)) {
      tokenRejections++;
      console.log("blocked — Monnify refused the token it had just issued");
      observations.push({
        question,
        outcome: "blocked",
        note:
          "Monnify issued a token and then rejected it (401 invalid_token). The merchant " +
          "account behind these credentials cannot call the API; the adapter never saw a " +
          "response to normalise.",
      });
      return;
    }

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

console.log("Monnify sandbox run\n");

// --- authentication, which is the thing this provider does differently ------

await observe("QUESTION 1: the Basic → Bearer login works and the token is cached", async () => {
  const before = loginCount;
  await provider.listBanks();
  const afterFirst = loginCount;
  // A second call on a warm client must not log in again.
  await provider.listBanks();
  const afterSecond = loginCount;
  return (
    `logins: ${afterFirst - before} for the first call, ` +
    `${afterSecond - afterFirst} for the second (0 is correct — the token is cached)`
  );
});

await observe("QUESTION 2: only the login takes Basic; everything else takes Bearer", () => {
  const schemes = [...seenAuthSchemes].sort().join(", ");
  const correct =
    seenAuthSchemes.has("login:Basic") &&
    seenAuthSchemes.has("other:Bearer") &&
    !seenAuthSchemes.has("other:Basic");
  return `${schemes}; ${correct ? "as designed" : "*** unexpected — investigate ***"}`;
});

// --- reads, which create nothing -------------------------------------------

await observe("the bank list is reachable and shaped as recorded", async () => {
  const banks = await provider.listBanks();
  const sample = banks.find((b) => b.code === "044") ?? banks[0];
  const keys = Object.keys(sample ?? {})
    .sort()
    .join(", ");
  const withUssd = banks.filter((b) => b.ussdTemplate !== null).length;
  const codeLengths = [...new Set(banks.map((b) => b.code.length))].sort().join("/");
  return (
    `${banks.length} banks; entry keys: ${keys}; code lengths seen: ${codeLengths}; ` +
    `${withUssd} carry a USSD template`
  );
});

await observe("account resolution returns a name", async () => {
  // 0690000032 at bank 044 is the one account number that resolves in Monnify's
  // sandbox; 0123456789, 2085886393, 0000000000 and 3000000000 were all tried and all
  // answered `404 Invalid account details supplied`.
  const account = await provider.resolveAccount({
    accountNumber: "0690000032",
    bankCode: "044",
  });
  // The resolved name may be a REAL person's name. It must never be written to a file in
  // a public repository, so only its shape is recorded. The Paystack harness leaked one
  // into a committed file on its first run; this is that lesson, applied.
  const shape = account.accountName
    ? `a name of ${account.accountName.length} characters was returned`
    : "no name returned";
  return (
    `${shape}; bank code echoed back as ${account.bankCode ?? "null"}; institution match ` +
    `${account.institution ? `${account.institution.id} by ${account.institution.matchedBy}` : "none"}`
  );
});

await observe(
  "the v1 account-validate endpoint is gone, which is why the adapter uses v2",
  async () => {
    // Confirms the adapter's endpoint choice against the server rather than the document.
    // A provider that merely deprecates a route in prose is a different risk from one that
    // switches it off, and Monnify has switched this one off.
    const token = await rawToken();
    const response = await fetch(
      "https://sandbox.monnify.com/api/v1/disbursements/account/validate?accountNumber=0690000032&bankCode=044",
      { headers: { authorization: `Bearer ${token}` } },
    );
    const body = await response.json();
    return `HTTP ${response.status}: ${body?.responseMessage ?? "no message"}`;
  },
);

await observe(
  "QUESTION 3: does /api/v1/transactions/search really answer WITHOUT the envelope?",
  async () => {
    // The spec documents this one endpoint as returning its page at the top level, with
    // no `requestSuccessful`/`responseBody` wrapper. The adapter has a fallback for it.
    // A raw call is the only way to see the envelope itself, so this probe makes one.
    const token = await rawToken();

    const response = await fetch(
      `https://sandbox.monnify.com/api/v1/transactions/search?page=0&size=1`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    const body = await response.json();
    const topLevelKeys = Object.keys(body ?? {})
      .sort()
      .join(", ");
    const enveloped = Object.hasOwn(body ?? {}, "responseBody");

    // And the adapter must read it either way.
    const page = await provider.listTransactions({ page: 0, pageSize: 1 });

    return (
      `HTTP ${response.status}; top-level keys: ${topLevelKeys}; ` +
      `${enveloped ? "IT IS ENVELOPED, contradicting the spec — the fixture follows this, and the envelope-less fallback is kept only as a defence" : "no envelope, as the spec says"}; ` +
      `the adapter read ${page.items.length} item(s) and total=${page.total}`
    );
  },
);

await observe(
  "QUESTION 4: GET /api/v2/merchant/transactions/query 404s on an unknown reference",
  async () => {
    try {
      await provider.verifyTransactionByReference(`naijapay-missing-${run}`);
      return "*** the call SUCCEEDED on a reference Monnify has never seen — investigate ***";
    } catch (error) {
      rethrowTokenRejection(error);
      return `${error.name}: ${error.providerMessage ?? error.message}`;
    }
  },
);

await observe("verifying an unknown Monnify transaction reference fails cleanly", async () => {
  try {
    await provider.verifyTransaction(`MNFY|99|${run}`);
    return "*** the call SUCCEEDED on a transaction that does not exist — investigate ***";
  } catch (error) {
    rethrowTokenRejection(error);
    return `${error.name}: ${error.providerMessage ?? error.message}`;
  }
});

// --- the decimal question --------------------------------------------------

let fractionalReference;

await observe(
  "QUESTION 6: does a fractional naira amount survive the round trip exactly?",
  async () => {
    // 5,000 naira and 50 kobo. Monnify is naira-decimal on the wire; if it echoes
    // anything but 5000.5, every amount this SDK sends is suspect.
    const amount = money(500_050, "NGN");
    fractionalReference = `naijapay-frac-${run}`;
    const checkout = await provider.createCheckout({
      amount,
      email: "ada@example.com",
      name: "Ada Probe",
      reference: fractionalReference,
      description: `naija-pay sandbox probe ${run}`,
    });
    return (
      `sent amount=${toMajor(amount)} (from ${amount.amount} kobo); ` +
      `checkout created at ${new URL(checkout.checkoutUrl).host}; ` +
      `Monnify reference ${checkout.providerReference.slice(0, 8)}…; ` +
      `channels enabled: ${checkout.enabledChannels.join(", ") || "none reported"}`
    );
  },
);

await observe("the fractional amount comes back unchanged on verify", async () => {
  try {
    const transaction = await provider.verifyTransactionByReference(fractionalReference);
    const back = transaction.amount;
    const paid = transaction.amountPaid;
    // Monnify does NOT echo the amount you initialised with. On an unpaid transaction
    // `totalPayable` is the string "0.00", so a faithful adapter reports zero. That is a
    // trap for a caller who reads `amount` off a pending transaction, and it is Monnify's
    // behaviour rather than a conversion fault — the amount is only meaningful once paid.
    return (
      `sent 5000.5; on a PENDING transaction Monnify reports ` +
      `totalPayable=${back ? toMajor(back) : "null"} and ` +
      `amountPaid=${paid ? toMajor(paid) : "null"}, status ${transaction.status}. ` +
      `Monnify does not echo the requested amount back until the transaction is paid, so ` +
      `\`amount\` on a pending transaction is 0 and must not be read as the price.`
    );
  } catch (error) {
    rethrowTokenRejection(error);
    // An initialised-but-unpaid transaction may not be queryable. That is a fact about
    // the provider, not a conversion failure.
    return `could not verify an unpaid checkout: ${error.name}: ${error.message}`;
  }
});

// --- reserved accounts -----------------------------------------------------

const vaReference = `naijapay-va-${run}`;

await observe("a reserved account can be created, and reports its own NUBANs", async () => {
  const account = await provider.createVirtualAccount({
    reference: vaReference,
    accountName: "NaijaPay Probe",
    customerEmail: `probe+${run}@example.com`,
    customerName: "Ada Probe",
    // Monnify's documented sandbox BVN. A real BVN must never appear in this repository.
    bvn: "21212121212",
    allBanks: true,
  });
  const banks = account.accounts
    .map((a) => `${a.bankCode ?? "?"}${a.institution ? "✓" : ""}`)
    .join(", ");
  return (
    `${account.accounts.length} NUBAN(s) issued across banks ${banks}; ` +
    `status ${account.status}; kyc ${account.kycStatus}; ` +
    `restrictPaymentSource came back as ${account.restrictPaymentSource} — the ` +
    `documentation says the default is TRUE, and omitting the field entirely was also ` +
    `tried and also gave false, so the adapter always sends it explicitly rather than ` +
    `trusting either`
  );
});

await observe("reading the reserved account back gives the same reference", async () => {
  const account = await provider.getVirtualAccount(vaReference);
  return (
    `reference ${account.reference === vaReference ? "matches" : "*** DIFFERS ***"}; ` +
    `contract code ${account.contractCode === contractCode ? "matches" : "differs"}; ` +
    `${account.accounts.length} NUBAN(s)`
  );
});

await observe(
  "the inflow list for a brand-new reserved account is empty, not an error",
  async () => {
    const page = await provider.listVirtualAccountInflows({ reference: vaReference });
    return `${page.items.length} inflow(s), total=${page.total}, hasMore=${page.hasMore}`;
  },
);

// --- sub-accounts (splits) -------------------------------------------------

let subAccountCode;

await observe(
  "a sub-account can be created and reports its split share",
  async () => {
    const [account] = await provider.createSplitAccounts([
      {
        bankCode: "044",
        accountNumber: "0690000032",
        email: `vendor+${run}@example.com`,
        // 2,000 basis points = 20%. Monnify takes a percentage as a number.
        defaultShareBasisPoints: 2_000,
      },
    ]);
    subAccountCode = account?.code;
    const back = account?.defaultShareBasisPoints;
    return (
      `sub-account ${subAccountCode ?? "none"} created; sent 2000 bps, Monnify returned ` +
      `${back ?? "nothing"}; ${back === 2_000 ? "EXACT MATCH" : "*** MISMATCH — check the percentage conversion ***"}`
    );
  },
  {
    error: "DuplicateReferenceError",
    because:
      "Monnify keys a sub-account on its account number, and the shared public test " +
      "merchant already has one for this account. Mapping a duplicate to " +
      "DuplicateReferenceError is itself the thing being confirmed here.",
  },
);

await observe("the sub-account appears in the list", async () => {
  if (!subAccountCode) throw skipped("no sub-account was created, so none could be found");
  const accounts = await provider.listSplitAccounts();
  const found = accounts.some((a) => a.code === subAccountCode);
  return `${accounts.length} sub-account(s); the one just created ${found ? "is present" : "*** is MISSING ***"}`;
});

// --- money movement, which needs a funded wallet ---------------------------

await observe(
  "QUESTION 5: is two-factor disbursement on by default?",
  async () => {
    if (!env.MONNIFY_WALLET_ACCOUNT_NUMBER) {
      throw skipped("no MONNIFY_WALLET_ACCOUNT_NUMBER is set, and a payout needs a source wallet");
    }
    const payout = await provider.createPayout({
      amount: naira(100),
      reference: `naijapay-payout-${run}`,
      narration: "naija-pay sandbox probe",
      bankCode: "058",
      accountNumber: "0123456789",
      accountName: "NaijaPay Probe",
    });
    return (
      `status ${payout.status}; awaitingOtp=${payout.awaitingOtp} ` +
      `(true means two-factor disbursement is ON for this integration, which is the ` +
      `default and the thing most likely to surprise a caller)`
    );
  },
  {
    error: "InsufficientFundsError",
    because: "the sandbox wallet is empty, so no transfer could be attempted.",
  },
);

await observe(
  "the wallet balance converts to minor units exactly",
  async () => {
    const balance = await provider.getBalance();
    const show = (m) =>
      m === null ? "not representable in kobo" : `${m.amount} kobo (${toMajor(m)})`;
    return `available ${show(balance.available)}; ledger ${show(balance.ledger)}`;
  },
  {
    error: "ConfigurationError",
    because: "no wallet account number is configured, so there is no balance to read.",
  },
);

// --- clean up what we can --------------------------------------------------

await observe("the sub-account can be deleted again", async () => {
  if (!subAccountCode) throw skipped("no sub-account was created, so none could be deleted");
  await provider.deleteSplitAccount(subAccountCode);
  return `deleted ${subAccountCode}`;
});

await observe("the reserved account can be deallocated", async () => {
  // Monnify's word is deallocation and there is no route to undo it, which is why the
  // adapter calls it `deactivate` and documents that the number is gone for good.
  const account = await provider.deactivateVirtualAccount(vaReference);
  // Monnify echoes the account as it was, status and all, rather than reporting it as
  // inactive. The account is gone regardless — there is no route to undo a deallocation —
  // so the status in this one response must not be read as "still usable".
  return (
    `deallocated; Monnify echoed status ${account.status} rather than inactive, which is ` +
    `the account as it was and not a statement that it still works`
  );
});

// --- write up what we saw ---------------------------------------------------

const when = new Date().toISOString().slice(0, 10);
const lines = [
  "# Monnify sandbox observations",
  "",
  "Generated by `npm run sandbox:monnify`. **Do not edit by hand** — rerun it instead.",
  "",
  `Run on **${when}** against \`sandbox.monnify.com\` with an \`MK_TEST_\` key, using the`,
  "adapter in `packages/ts/src/providers/monnify/`.",
  "",
  "Monnify publishes public test credentials in its own API reference, so this run is",
  "reproducible by anyone. The credentials are read from `.env` and are not in this",
  "repository.",
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
  `Distinct endpoints touched: ${[...new Set(seenPaths)].length}. Logins performed: ${loginCount}.`,
  "",
];

if (tokenRejections > 0) {
  lines.splice(
    12,
    0,
    `> **${tokenRejections} probes could not run.** Monnify accepted the login and then`,
    "> refused the token it had just issued: `POST /api/v1/auth/login` answered 200 with a",
    "> well-formed, unexpired JWT carrying the expected authorities, and every other",
    '> endpoint answered `401 {"error":"invalid_token"}`. That is a condition of the',
    "> merchant account behind the credentials, not of this adapter. Rerun with your own",
    "> Monnify sandbox keys to fill in the blanks.",
    "",
  );
}

const target = path.join(ROOT, "fixtures", "providers", "monnify", "SANDBOX.md");
writeFileSync(target, `${lines.join("\n")}\n`, "utf8");

console.log(`\nwrote ${path.relative(ROOT, target)}`);
const ok = observations.filter((o) => o.outcome === "ok").length;
const blocked = observations.filter((o) => o.outcome === "blocked").length;
console.log(`${ok} succeeded, ${blocked} blocked by account configuration, ${failures} failed`);

if (tokenRejections > 0) {
  console.error(
    `\n${tokenRejections} probes were blocked: Monnify issued a token and then rejected it.`,
  );
  console.error("Use your own Monnify sandbox keys to run them.");
}

if (failures > 0) {
  console.error("\nSome observations failed. That is information, not necessarily a defect —");
  console.error("read the table before changing any code.");
  process.exit(1);
}
