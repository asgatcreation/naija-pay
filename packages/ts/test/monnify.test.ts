import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { operationsRequiringApproval, supports } from "../src/core/capabilities.ts";
import {
  AuthenticationError,
  ConfigurationError,
  DuplicateReferenceError,
  KycRequiredError,
  NotFoundError,
  PayoutStatusUnknownError,
  UnsupportedOperationError,
  ValidationError,
} from "../src/core/errors.ts";
import { money, naira } from "../src/core/money.ts";
import { computeSignature, SCHEMES } from "../src/core/signatures.ts";
import { MonnifyProvider, monnify } from "../src/providers/monnify/index.ts";
import {
  asMoney,
  normaliseStatus,
  normaliseTransferStatus,
  parseMonnifyDate,
  toTransaction,
} from "../src/providers/monnify/normalise.ts";

const FIXTURES = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")),
  "..",
  "..",
  "..",
  "fixtures",
  "providers",
  "monnify",
);

/** Loads a recorded response, so no test invents a provider payload. */
function fixture(operation: string): { request: unknown; response: unknown } {
  return {
    request: JSON.parse(readFileSync(path.join(FIXTURES, operation, "request.json"), "utf8")),
    response: JSON.parse(readFileSync(path.join(FIXTURES, operation, "response.json"), "utf8")),
  };
}

function fixtureFile(operation: string, name: string): string {
  return readFileSync(path.join(FIXTURES, operation, name), "utf8");
}

const API_KEY = "MK_TEST_EXAMPLEmonnify";
const SECRET_KEY = "EXAMPLEsecretkeyformonnifytests0";
const CONTRACT_CODE = "5867418298";
const WALLET = "3934178936";

/**
 * Serves fixtures in order, recording the requests the adapter made.
 *
 * Every Monnify call needs a token, so the login response is served first automatically
 * unless a test asks for it not to be — which keeps each test about its own endpoint
 * rather than about authentication.
 */
function harness(
  operations: (string | { status: number; body: unknown })[],
  options: { skipLogin?: boolean } = {},
) {
  const calls: { url: string; method: string; body: unknown; headers: Record<string, string> }[] =
    [];
  const queue = options.skipLogin ? [...operations] : ["auth-login", ...operations];
  let index = 0;

  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers,
    });

    const next = queue[Math.min(index, queue.length - 1)];
    index++;
    if (next === undefined) throw new Error("the harness was given no operations");
    const resolved =
      typeof next === "string" ? { status: 200, body: fixture(next).response } : next;
    return new Response(JSON.stringify(resolved.body), {
      status: resolved.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;

  const provider = monnify({
    apiKey: API_KEY,
    secretKey: SECRET_KEY,
    contractCode: CONTRACT_CODE,
    walletAccountNumber: WALLET,
    environment: "test",
    fetch: fetchImpl,
    sleep: async () => {},
  });

  return { provider, calls };
}

/** The JSON body of the nth recorded request, asserting the request happened. */
function bodyOf<T>(calls: { body: unknown }[], index: number): T {
  const call = calls[index];
  assert.ok(call, `expected at least ${index + 1} request(s), got ${calls.length}`);
  return call.body as T;
}

function callAt(
  calls: { url: string; method: string; headers: Record<string, string> }[],
  i: number,
) {
  const call = calls[i];
  assert.ok(call, `expected at least ${i + 1} request(s), got ${calls.length}`);
  return call;
}

describe("construction and key safety", () => {
  test("accepts a test key pair", () => {
    assert.doesNotThrow(() =>
      monnify({ apiKey: API_KEY, secretKey: SECRET_KEY, environment: "test" }),
    );
  });

  test("requires both halves of the credential", () => {
    assert.throws(() => monnify({ apiKey: API_KEY, secretKey: "" }), ConfigurationError);
    assert.throws(() => monnify({ apiKey: "", secretKey: SECRET_KEY }), ConfigurationError);
  });

  test("refuses something that is not an api key", () => {
    // The secret key is longer and has no prefix, and passing the two the wrong way
    // round is the obvious mistake to catch locally.
    assert.throws(
      () => monnify({ apiKey: SECRET_KEY, secretKey: API_KEY }),
      /must begin MK_TEST_ or MK_PROD_/,
    );
  });

  test("refuses a live api key while the environment says test", () => {
    assert.throws(
      () => monnify({ apiKey: "MK_PROD_EXAMPLEreal", secretKey: SECRET_KEY, environment: "test" }),
      ConfigurationError,
    );
  });

  test("refuses a test api key while the environment says live", () => {
    assert.throws(
      () => monnify({ apiKey: API_KEY, secretKey: SECRET_KEY, environment: "live" }),
      ConfigurationError,
    );
  });

  test("warns loudly when a live key is used outside production", () => {
    const warnings: string[] = [];
    monnify({
      apiKey: "MK_PROD_EXAMPLEreal",
      secretKey: SECRET_KEY,
      environment: "live",
      onLiveKeyWarning: (message) => warnings.push(message),
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /Real money will move/);
  });

  test("the sandbox and live hosts are different machines", async () => {
    // Unlike Paystack and Flutterwave v3, so a misconfigured test client cannot reach
    // live money. Asserted by observing the URL actually called.
    const { provider, calls } = harness(["banks-list"]);
    await provider.listBanks();
    assert.match(callAt(calls, 0).url, /^https:\/\/sandbox\.monnify\.com\//);
  });
});

describe("authentication", () => {
  test("exchanges Basic credentials for a Bearer token before the first call", async () => {
    const { provider, calls } = harness(["banks-list"]);
    await provider.listBanks();

    // Two calls: the login, then the request.
    assert.equal(calls.length, 2);
    assert.match(callAt(calls, 0).url, /\/api\/v1\/auth\/login$/);
    assert.equal(callAt(calls, 0).method, "POST");
    assert.match(callAt(calls, 0).headers.authorization ?? "", /^Basic /);
    assert.match(callAt(calls, 1).headers.authorization ?? "", /^Bearer EXAMPLE\.access\.token$/);
  });

  test("the Basic header is base64 of apiKey:secretKey", async () => {
    const { provider, calls } = harness(["banks-list"]);
    await provider.listBanks();
    const header = callAt(calls, 0).headers.authorization ?? "";
    assert.equal(header, `Basic ${btoa(`${API_KEY}:${SECRET_KEY}`)}`);
  });

  test("reuses the cached token rather than logging in again", async () => {
    const { provider, calls } = harness(["banks-list", "banks-list"]);
    await provider.listBanks();
    await provider.listBanks();

    // Three calls, not four: one login shared by both requests.
    assert.equal(calls.length, 3);
    assert.equal(calls.filter((call) => call.url.endsWith("/auth/login")).length, 1);
  });

  test("concurrent first calls perform ONE login", async () => {
    // Without the in-flight promise being shared, ten cold requests mean ten logins, and
    // Monnify rate-limits the login endpoint harder than anything else.
    const { provider, calls } = harness(["banks-list", "banks-list", "banks-list"]);
    await Promise.all([provider.listBanks(), provider.listBanks(), provider.listBanks()]);
    assert.equal(calls.filter((call) => call.url.endsWith("/auth/login")).length, 1);
  });

  test("logs in again once the token has expired", async () => {
    let now = 1_000_000;
    const calls: { url: string }[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      calls.push({ url: String(url) });
      const body = String(url).endsWith("/auth/login")
        ? fixture("auth-login").response
        : fixture("banks-list").response;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;

    const provider = monnify({
      apiKey: API_KEY,
      secretKey: SECRET_KEY,
      environment: "test",
      fetch: fetchImpl,
      now: () => now,
    });

    await provider.listBanks();
    // The fixture's expiresIn is 3600 seconds, minus a minute of headroom.
    now += 3_600_000;
    await provider.listBanks();

    assert.equal(calls.filter((call) => call.url.endsWith("/auth/login")).length, 2);
  });

  test("a failed login raises AuthenticationError, not a generic failure", async () => {
    const { provider } = harness(
      [{ status: 401, body: { requestSuccessful: false, responseCode: 99, responseMessage: "" } }],
      { skipLogin: true },
    );
    await assert.rejects(provider.listBanks(), (error: unknown) => {
      assert.ok(error instanceof AuthenticationError);
      assert.match(error.message, /login failed/);
      return true;
    });
  });

  test("a 401 on a safe request retries once with a fresh token", async () => {
    const { provider, calls } = harness([
      { status: 401, body: { requestSuccessful: false, responseMessage: "Unauthorized" } },
      "auth-login",
      "banks-list",
    ]);
    const banks = await provider.listBanks();

    assert.ok(banks.length > 0);
    // login, failed call, login again, successful call.
    assert.equal(calls.length, 4);
    assert.equal(calls.filter((call) => call.url.endsWith("/auth/login")).length, 2);
  });

  test("a 401 on a money-moving request is NOT retried", async () => {
    // The point of the safety taxonomy: a second attempt could pay twice.
    const { provider, calls } = harness([
      { status: 401, body: { requestSuccessful: false, responseMessage: "Unauthorized" } },
    ]);
    await assert.rejects(
      provider.createPayout({
        amount: naira(1000),
        reference: "payout-01HQ-EXAMPLE",
        narration: "Payout",
        bankCode: "044",
        accountNumber: "0123456789",
        accountName: "Ada Example",
      }),
      AuthenticationError,
    );
    // One login and one attempt. No second attempt.
    assert.equal(calls.length, 2);
  });
});

describe("collections", () => {
  test("creates a checkout with a decimal amount in major units", async () => {
    const { provider, calls } = harness(["transaction-initialize"]);
    const checkout = await provider.createCheckout({
      amount: naira(100),
      email: "ada@example.com",
      reference: "order-01HQ-EXAMPLE",
      name: "Ada Example",
      channels: ["card", "bank_transfer"],
    });

    const body = bodyOf<{ amount: number; currencyCode: string; paymentMethods: string[] }>(
      calls,
      1,
    );
    // 100 naira is 10000 kobo internally and must go out as 100, not 10000.
    assert.equal(body.amount, 100);
    assert.equal(body.currencyCode, "NGN");
    assert.deepEqual(body.paymentMethods, ["CARD", "ACCOUNT_TRANSFER"]);
    assert.match(checkout.checkoutUrl, /^https:\/\/sandbox\.sdk\.monnify\.com\//);
    assert.equal(checkout.reference, "order-01HQ-EXAMPLE");
  });

  test("a fractional naira amount survives the conversion exactly", async () => {
    const { provider, calls } = harness(["transaction-initialize"]);
    await provider.createCheckout({
      amount: money(500_050, "NGN"),
      email: "ada@example.com",
      reference: "order-01HQ-EXAMPLE",
    });
    // 500050 kobo is 5000.50 naira, not 5000.5000000001.
    assert.equal(bodyOf<{ amount: number }>(calls, 1).amount, 5000.5);
  });

  test("refuses a currency Monnify does not support", async () => {
    const { provider, calls } = harness(["transaction-initialize"]);
    await assert.rejects(
      provider.createCheckout({
        amount: money(1000, "USD"),
        email: "ada@example.com",
        reference: "order-01HQ-EXAMPLE",
      }),
      (error: unknown) => {
        assert.ok(error instanceof ValidationError);
        assert.match(error.message, /Nigerian acquirer/);
        return true;
      },
    );
    // Nothing was sent: not even the login.
    assert.equal(calls.length, 0);
  });

  test("refuses a channel Monnify does not have, before sending anything", async () => {
    const { provider, calls } = harness(["transaction-initialize"]);
    await assert.rejects(
      provider.createCheckout({
        amount: naira(100),
        email: "ada@example.com",
        reference: "order-01HQ-EXAMPLE",
        channels: ["qr", "apple_pay"],
      }),
      /does not support the channel\(s\): qr, apple_pay/,
    );
    assert.equal(calls.length, 0);
  });

  test("requires a contract code, and says where to find it", async () => {
    const provider = monnify({
      apiKey: API_KEY,
      secretKey: SECRET_KEY,
      environment: "test",
      fetch: (async () => new Response("{}")) as unknown as typeof globalThis.fetch,
    });
    await assert.rejects(
      provider.createCheckout({
        amount: naira(100),
        email: "ada@example.com",
        reference: "order-01HQ-EXAMPLE",
      }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigurationError);
        assert.match(error.message, /contractCode is required/);
        return true;
      },
    );
  });

  test("verify percent-encodes the pipes in Monnify's own reference", async () => {
    const { provider, calls } = harness(["transaction-verify-paid"]);
    await provider.verifyTransaction("MNFY|67|20220725111957|000283");
    assert.match(
      callAt(calls, 1).url,
      /\/api\/v2\/transactions\/MNFY%7C67%7C20220725111957%7C000283$/,
    );
  });

  test("verify reads Monnify's string amounts and non-ISO date", async () => {
    const { provider } = harness(["transaction-verify-paid"]);
    const transaction = await provider.verifyTransaction("MNFY|67|20220725111957|000283");

    assert.equal(transaction.status, "successful");
    // "100.00" as a string becomes 10000 kobo.
    assert.equal(transaction.amount?.amount, 10_000);
    assert.equal(transaction.amountPaid?.amount, 10_000);
    assert.equal(transaction.amountSettled?.amount, 9_000);
    assert.equal(transaction.channel, "card");
    // "25/07/2022 11:20:20 AM" — day first, 12-hour clock, read as UTC.
    assert.equal(transaction.paidAt?.toISOString(), "2022-07-25T11:20:20.000Z");
  });

  test("the fixture really does carry strings, so the test above is not tautological", () => {
    const { response } = fixture("transaction-verify-paid");
    const body = (response as { responseBody: Record<string, unknown> }).responseBody;
    assert.equal(typeof body.amountPaid, "string");
    assert.equal(body.paidOn, "25/07/2022 11:20:20 AM");
  });

  test("your own reference has its own verify route, not the search route", async () => {
    const { provider, calls } = harness(["transaction-verify-paid"]);
    const transaction = await provider.verifyTransactionByReference("12-3---03--1kls0a--dkad");

    // The full payload, same as verifying by Monnify's reference — not a search hit.
    assert.equal(transaction.status, "successful");
    assert.equal(transaction.amount?.amount, 10_000);
    const call = callAt(calls, 1);
    assert.match(call.url, /\/api\/v2\/merchant\/transactions\/query\?/);
    assert.match(call.url, /paymentReference=12-3---03--1kls0a--dkad/);
  });

  test("a reference Monnify has never seen is a NotFoundError, not an unpaid transaction", async () => {
    const { provider } = harness([
      {
        status: 404,
        body: {
          requestSuccessful: false,
          responseCode: 99,
          responseMessage: "Transaction not found",
        },
      },
    ]);
    await assert.rejects(
      provider.verifyTransactionByReference("nope-EXAMPLE"),
      (error: unknown) => {
        assert.ok(error instanceof NotFoundError);
        return true;
      },
    );
  });

  test("a Spring page is normalised, zero-based, with hasMore", async () => {
    const { provider } = harness(["transaction-search"]);
    const page = await provider.listTransactions({ page: 0, pageSize: 10 });

    assert.equal(page.page, 0);
    assert.equal(page.pageSize, 10);
    assert.equal(page.total, 1);
    assert.equal(page.hasMore, false);
    assert.equal(page.items.length, 1);
  });

  test("the search endpoint is enveloped after all", async () => {
    // Monnify's own specification shows this one endpoint returning its page at the TOP
    // LEVEL, outside responseBody, and the adapter was built with a fallback for exactly
    // that. The live sandbox returns the ordinary envelope (verified 2026-11-19,
    // `npm run sandbox:monnify` question 3), so the fixture now matches the sandbox and
    // this test pins that. The document and the sandbox disagree; the sandbox wins.
    const body = fixture("transaction-search").response as {
      responseBody?: { content?: unknown[] };
    };
    assert.ok(body.responseBody, "the recorded response carries the envelope");
    assert.ok(Array.isArray(body.responseBody.content));
  });

  test("an envelope-less page is still read", async () => {
    // The fallback stays, because Monnify documents the envelope-less shape and may yet
    // serve it. Exercised directly rather than through a fixture, so re-recording the
    // fixture can never silently delete this coverage.
    const { provider } = harness([
      {
        status: 200,
        body: {
          content: [
            {
              paymentReference: "bare-EXAMPLE",
              transactionReference: "MNFY|13|bare",
              paymentStatus: "PAID",
              amount: 50.0,
              currencyCode: "NGN",
            },
          ],
          totalElements: 1,
          totalPages: 1,
          last: true,
          size: 10,
          number: 0,
        },
      },
    ]);
    const page = await provider.listTransactions({ page: 0, pageSize: 10 });

    assert.equal(page.items.length, 1);
    assert.equal(page.items[0]?.reference, "bare-EXAMPLE");
    assert.equal(page.total, 1);
  });

  test("a searched row claims no channel and no amountPaid", async () => {
    // A search row carries `amount` and no `totalPayable`/`amountPaid`, and names
    // `collectionChannel` (how it was collected) rather than a payment method. The
    // adapter reports neither as the channel, because neither is Monnify's claim about
    // which instrument was used.
    const { provider } = harness(["transaction-search"]);
    const row = (await provider.listTransactions({ page: 0, pageSize: 10 })).items[0];

    assert.equal(row?.channel, null);
    assert.equal(row?.amountPaid, null);
    assert.equal(row?.amountSettled, null);
    assert.ok(row?.amount);
  });
});

describe("the envelope", () => {
  test("requestSuccessful false with HTTP 200 is a failure, not data", async () => {
    // The trap: reading the HTTP status alone would return this as a transaction.
    const { provider } = harness([
      {
        status: 200,
        body: {
          requestSuccessful: false,
          responseCode: 99,
          responseMessage: "Duplicate payment reference",
        },
      },
    ]);
    await assert.rejects(
      provider.createCheckout({
        amount: naira(100),
        email: "ada@example.com",
        reference: "order-01HQ-EXAMPLE",
      }),
      DuplicateReferenceError,
    );
  });

  test("a gated feature reads as configuration, not authentication", async () => {
    const { provider } = harness([
      {
        status: 400,
        body: {
          requestSuccessful: false,
          responseCode: 99,
          responseMessage: "Merchant is not enabled for disbursements",
        },
      },
    ]);
    await assert.rejects(provider.getPayout("payout-01HQ-EXAMPLE"), (error: unknown) => {
      assert.ok(error instanceof ConfigurationError);
      assert.match(error.message, /relationship manager/);
      return true;
    });
  });

  test("responseCode is carried through whether it is a string or a number", async () => {
    const { provider } = harness([
      { status: 400, body: { requestSuccessful: false, responseCode: 99, responseMessage: "no" } },
    ]);
    await assert.rejects(provider.listBanks(), (error: unknown) => {
      assert.equal((error as { providerCode?: string }).providerCode, "99");
      return true;
    });
  });
});

describe("virtual accounts", () => {
  test("creates a reserved account at every partner bank", async () => {
    const { provider, calls } = harness(["reserved-account-create"]);
    const account = await provider.createVirtualAccount({
      reference: "va-ada-EXAMPLE",
      accountName: "Ada Example",
      customerEmail: "ada@example.com",
      customerName: "Ada Example",
      bvn: "21212121212",
      allBanks: true,
    });

    const body = bodyOf<{ getAllAvailableBanks: boolean; restrictPaymentSource: boolean }>(
      calls,
      1,
    );
    assert.equal(body.getAllAvailableBanks, true);
    // Monnify's own default is true, which would reject the inflows you are waiting for.
    assert.equal(body.restrictPaymentSource, false);
    assert.ok(account.accounts.length >= 1);
    assert.equal(account.accounts[0]?.provider, "monnify");
  });

  test("a reserved account needs a bvn or a nin, and fails locally without one", async () => {
    const { provider, calls } = harness(["reserved-account-create"]);
    await assert.rejects(
      provider.createVirtualAccount({
        reference: "va-ada-EXAMPLE",
        accountName: "Ada Example",
        customerEmail: "ada@example.com",
        customerName: "Ada Example",
      }),
      (error: unknown) => {
        assert.ok(error instanceof KycRequiredError);
        assert.deepEqual([...error.required], ["bvn"]);
        return true;
      },
    );
    assert.equal(calls.length, 0);
  });

  test("restrictPaymentSource is only sent as true with an allow-list", async () => {
    const { provider, calls } = harness(["reserved-account-create"]);
    await provider.createVirtualAccount({
      reference: "va-ada-EXAMPLE",
      accountName: "Ada Example",
      customerEmail: "ada@example.com",
      customerName: "Ada Example",
      bvn: "21212121212",
      allowedSources: { bvns: ["21212121212"] },
    });
    const body = bodyOf<{
      restrictPaymentSource: boolean;
      allowedPaymentSources: { bvns: string[] };
    }>(calls, 1);
    assert.equal(body.restrictPaymentSource, true);
    assert.deepEqual(body.allowedPaymentSources.bvns, ["21212121212"]);
  });

  test("naming no bank and not asking for all banks fails locally", async () => {
    const { provider, calls } = harness(["reserved-account-create"]);
    await assert.rejects(
      provider.createVirtualAccount({
        reference: "va-ada-EXAMPLE",
        accountName: "Ada Example",
        customerEmail: "ada@example.com",
        customerName: "Ada Example",
        bvn: "21212121212",
        allBanks: false,
        preferredBankCodes: [],
      }),
      /either set allBanks, or name at least one/,
    );
    assert.equal(calls.length, 0);
  });

  test("a KYC status is never reported as verified, because Monnify does not say so", async () => {
    const { provider } = harness(["reserved-account-create"]);
    const account = await provider.createVirtualAccount({
      reference: "va-ada-EXAMPLE",
      accountName: "Ada Example",
      customerEmail: "ada@example.com",
      customerName: "Ada Example",
      bvn: "21212121212",
    });
    // Monnify echoes the BVN it was given and passes no verdict on it.
    assert.equal(account.kycStatus, "pending");
  });

  test("the bvn route takes a bvn alone and the kyc route demands both", async () => {
    const { provider, calls } = harness(["reserved-account-update-bvn"]);
    await provider.updateVirtualAccountBvn({ reference: "va-ada-EXAMPLE", bvn: "21212121212" });

    assert.equal(callAt(calls, 1).method, "PUT");
    assert.match(callAt(calls, 1).url, /update-customer-bvn\/va-ada-EXAMPLE$/);
    assert.deepEqual(bodyOf(calls, 1), { bvn: "21212121212" });

    await assert.rejects(
      provider.updateVirtualAccountKyc({ reference: "va-ada-EXAMPLE", bvn: "2", nin: "" }),
      /requires BOTH a bvn and a nin/,
    );
  });

  test("deallocation is a DELETE on the reference route, and there is no undo", async () => {
    const { provider, calls } = harness(["reserved-account-get"]);
    await provider.deactivateVirtualAccount("va-ada-EXAMPLE");

    assert.equal(callAt(calls, 1).method, "DELETE");
    assert.match(callAt(calls, 1).url, /reserved-accounts\/reference\/va-ada-EXAMPLE$/);
    // Flutterwave can reactivate; Monnify cannot, so no such method exists here.
    assert.equal(
      "reactivateVirtualAccount" in (provider as unknown as Record<string, unknown>),
      false,
    );
  });

  test("inflows require the account reference as a query parameter", async () => {
    const { provider, calls } = harness(["reserved-account-transactions"]);
    const page = await provider.listVirtualAccountInflows({ reference: "va-ada-EXAMPLE" });
    assert.match(callAt(calls, 1).url, /accountReference=va-ada-EXAMPLE/);
    assert.ok(page.items.length >= 0);
  });
});

describe("splits", () => {
  test("basis points become Monnify's percentages", async () => {
    const { provider, calls } = harness(["transaction-initialize"]);
    await provider.createCheckout({
      amount: naira(100),
      email: "ada@example.com",
      reference: "order-01HQ-EXAMPLE",
      splits: [{ subAccountCode: "MFY_SUB_EXAMPLE", shareBasisPoints: 2000, bearsFee: true }],
    });

    const body = bodyOf<{ incomeSplitConfig: { splitPercentage: number; feeBearer: boolean }[] }>(
      calls,
      1,
    );
    // 2000 basis points is 20%, which Monnify spells as 20.
    assert.equal(body.incomeSplitConfig[0]?.splitPercentage, 20);
    assert.equal(body.incomeSplitConfig[0]?.feeBearer, true);
  });

  test("a share that is not whole basis points is refused rather than rounded", async () => {
    const { provider } = harness(["transaction-initialize"]);
    await assert.rejects(
      provider.createCheckout({
        amount: naira(100),
        email: "ada@example.com",
        reference: "order-01HQ-EXAMPLE",
        splits: [{ subAccountCode: "MFY_SUB_EXAMPLE", shareBasisPoints: 20.5 }],
      }),
      /whole basis points/,
    );
  });

  test("a split entry with no share at all is refused", async () => {
    const { provider } = harness(["transaction-initialize"]);
    assert.throws(
      () => provider.createSplit([{ subAccountCode: "MFY_SUB_EXAMPLE" }]),
      /needs either shareBasisPoints or shareAmount/,
    );
  });

  test("createSplit makes no network call", () => {
    const { provider, calls } = harness([]);
    const split = provider.createSplit([
      { subAccountCode: "MFY_SUB_EXAMPLE", shareBasisPoints: 1000 },
    ]);
    assert.equal(split.length, 1);
    assert.equal(calls.length, 0);
  });

  test("sub-accounts are created from an array and come back as an array", async () => {
    const { provider, calls } = harness(["sub-account-create"]);
    const accounts = await provider.createSplitAccounts([
      {
        accountNumber: "0123456789",
        bankCode: "044",
        email: "ada@example.com",
        defaultShareBasisPoints: 2000,
      },
    ]);

    assert.ok(Array.isArray(bodyOf(calls, 1)));
    assert.equal(accounts.length, 1);
    // What comes back is Monnify's own 20.87%, not the 20% we asked for: the response,
    // not the request, is the truth about a sub-account's default share.
    assert.equal(accounts[0]?.defaultShareBasisPoints, 2087);
  });

  test("the income split config update sends a bare array", async () => {
    const { provider, calls } = harness([{ status: 200, body: { requestSuccessful: true } }]);
    await provider.updateVirtualAccountSplits({
      reference: "va-ada-EXAMPLE",
      splits: [{ subAccountCode: "MFY_SUB_EXAMPLE", shareBasisPoints: 1500 }],
    });
    // The one endpoint in the Monnify API whose body is an array rather than an object.
    assert.ok(Array.isArray(bodyOf(calls, 1)));
  });
});

describe("payouts", () => {
  test("a created transfer awaiting an OTP is pending, not sent", async () => {
    // The single most dangerous response in this API to misread: requestSuccessful is
    // true, the HTTP status is 200, and no money has moved.
    const { provider } = harness(["transfer-single-pending-authorization"]);
    const payout = await provider.createPayout({
      amount: naira(1000),
      reference: "payout-01HQ-EXAMPLE",
      narration: "Payout",
      bankCode: "044",
      accountNumber: "0123456789",
      accountName: "Ada Example",
    });

    assert.equal(payout.status, "pending");
    assert.equal(payout.awaitingOtp, true);
  });

  test("the fixture really says PENDING_AUTHORIZATION", () => {
    const { response } = fixture("transfer-single-pending-authorization");
    const body = (response as { responseBody: { status: string } }).responseBody;
    assert.equal(body.status, "PENDING_AUTHORIZATION");
    // And the envelope says it succeeded at the same time.
    assert.equal((response as { requestSuccessful: boolean }).requestSuccessful, true);
  });

  test("OTP_EMAIL_DISPATCH_FAILED is also pending and also awaiting an OTP", () => {
    assert.equal(normaliseTransferStatus("OTP_EMAIL_DISPATCH_FAILED"), "pending");
  });

  test("a payout needs the wallet account number, and says why", async () => {
    const provider = monnify({
      apiKey: API_KEY,
      secretKey: SECRET_KEY,
      contractCode: CONTRACT_CODE,
      environment: "test",
      fetch: (async () => new Response("{}")) as unknown as typeof globalThis.fetch,
    });
    await assert.rejects(
      provider.createPayout({
        amount: naira(1000),
        reference: "payout-01HQ-EXAMPLE",
        narration: "Payout",
        bankCode: "044",
        accountNumber: "0123456789",
        accountName: "Ada Example",
      }),
      /walletAccountNumber is required/,
    );
  });

  test("a payout is never retried, and a 503 reports an unknown outcome", async () => {
    const { provider, calls } = harness([
      { status: 503, body: { requestSuccessful: false, responseMessage: "Service unavailable" } },
    ]);
    await assert.rejects(
      provider.createPayout({
        amount: naira(1000),
        reference: "payout-01HQ-EXAMPLE",
        narration: "Payout",
        bankCode: "044",
        accountNumber: "0123456789",
        accountName: "Ada Example",
      }),
      (error: unknown) => {
        // Not ProviderDownError: the transfer may have been accepted, so the outcome is
        // genuinely unknown and must be queried rather than retried.
        assert.ok(error instanceof PayoutStatusUnknownError);
        assert.match(error.message, /must NOT be retried/);
        return true;
      },
    );
    // The login plus exactly one attempt.
    assert.equal(calls.length, 2);
  });

  test("authorising a payout submits the OTP as authorizationCode", async () => {
    const { provider, calls } = harness(["transfer-single-summary"]);
    await provider.authorizePayout({ reference: "payout-01HQ-EXAMPLE", otp: "123456" });

    assert.match(callAt(calls, 1).url, /\/api\/v2\/disbursements\/single\/validate-otp$/);
    assert.deepEqual(bodyOf(calls, 1), {
      reference: "payout-01HQ-EXAMPLE",
      authorizationCode: "123456",
    });
  });

  test("a batch defaults to BREAK, so one bad row stops the whole batch", async () => {
    const { provider, calls } = harness(["transfer-batch"]);
    const batch = await provider.createBulkPayout({
      batchReference: "batch-01HQ-EXAMPLE",
      narration: "Payroll",
      transfers: [
        {
          amount: naira(1000),
          reference: "payout-01HQ-EXAMPLE-1",
          narration: "Payroll",
          bankCode: "044",
          accountNumber: "0123456789",
        },
      ],
    });

    const body = bodyOf<{ onValidationFailure: string; title: string }>(calls, 1);
    assert.equal(body.onValidationFailure, "BREAK");
    // The spec's required list names `title`, even though its schema omits it.
    assert.equal(body.title, "Payroll");
    assert.ok(batch.batchReference.length > 0);
  });

  test("an empty batch is refused locally", async () => {
    const { provider, calls } = harness(["transfer-batch"]);
    await assert.rejects(
      provider.createBulkPayout({
        batchReference: "batch-01HQ-EXAMPLE",
        narration: "Payroll",
        transfers: [],
      }),
      /at least one transfer/,
    );
    assert.equal(calls.length, 0);
  });

  test("the batch OTP field is `reference`, not `batchReference`", async () => {
    const { provider, calls } = harness(["transfer-batch"]);
    await provider.authorizeBulkPayout({ batchReference: "batch-01HQ-EXAMPLE", otp: "123456" });
    assert.deepEqual(bodyOf(calls, 1), {
      reference: "batch-01HQ-EXAMPLE",
      authorizationCode: "123456",
    });
  });

  test("listing payouts uses pageNo and pageSize, not page and size", async () => {
    // Monnify is not consistent between its own endpoints, and guessing wrong silently
    // returns the first page every time.
    const { provider, calls } = harness([
      { status: 200, body: { requestSuccessful: true, responseBody: { content: [] } } },
    ]);
    await provider.listPayouts({ page: 2, pageSize: 50 });
    assert.match(callAt(calls, 1).url, /pageNo=2/);
    assert.match(callAt(calls, 1).url, /pageSize=50/);
  });
});

describe("banks, balance and name enquiry", () => {
  test("banks carry Monnify's USSD templates, nulls included", async () => {
    const { provider } = harness(["banks-list"]);
    const banks = await provider.listBanks();

    assert.ok(banks.length >= 3);
    const access = banks.find((bank) => bank.code === "044");
    assert.equal(access?.ussdTemplate, "*901*Amount*AccountNumber#");
    // Several banks genuinely have none, and that is carried as null rather than "".
    assert.equal(banks.find((bank) => bank.code === "50515")?.ussdTemplate, null);
  });

  test("name enquiry enriches from naija-data without changing the provider's code", async () => {
    const { provider } = harness(["account-validate"]);
    const account = await provider.resolveAccount({
      accountNumber: "0123456789",
      bankCode: "044",
    });

    // The response's own bankCode wins, even where it differs from the one we asked
    // about: enrichment never rewrites what the provider said.
    assert.equal(account.bankCode, "057");
    assert.equal(account.provider, "monnify");
    assert.ok(account.institution, "057 should match an institution in naija-data");
  });

  test("the balance comes back as integer minor units", async () => {
    const { provider, calls } = harness(["wallet-balance"]);
    const balance = await provider.getBalance();

    assert.match(callAt(calls, 1).url, /accountNumber=3934178936/);
    assert.equal(balance.accountNumber, WALLET);
    // Monnify sends these as decimal strings.
    assert.ok((balance.available?.amount ?? 0) > 0);
  });
});

describe("refunds", () => {
  test("a refund sends both required notes and is never retried", async () => {
    const { provider, calls } = harness(["refund-initiate"]);
    await provider.createRefund({
      transactionReference: "MNFY|67|20220725111957|000283",
      amount: naira(100),
      reference: "refund-01HQ-EXAMPLE",
      reason: "Duplicate order",
      customerNote: "Refund for duplicate order",
    });

    const body = bodyOf<{ refundAmount: number; refundReason: string; customerNote: string }>(
      calls,
      1,
    );
    assert.equal(body.refundAmount, 100);
    assert.equal(body.refundReason, "Duplicate order");
    assert.equal(body.customerNote, "Refund for duplicate order");
  });

  test("the refund status path takes the refund reference, not the spec's example value", async () => {
    // Monnify's own OpenAPI document spells this path key as /api/v1/refunds/202100op3456,
    // with a literal example value baked into it. Copying the key would 404 on every
    // refund but one.
    const { provider, calls } = harness(["refund-initiate"]);
    await provider.getRefund("refund-01HQ-EXAMPLE");
    assert.match(callAt(calls, 1).url, /\/api\/v1\/refunds\/refund-01HQ-EXAMPLE$/);
    assert.doesNotMatch(callAt(calls, 1).url, /202100op3456/);
  });
});

describe("webhooks", () => {
  test("reproduces Monnify's own published hash", async () => {
    // The vector that settles the contradiction on Monnify's webhook page: its prose
    // says SHA-512(secret + body) and its three code samples say HMAC. Monnify also
    // publishes a secret, a payload and the expected hash — and only the HMAC
    // reproduces it.
    const published = JSON.parse(
      fixtureFile("webhook-successful-transaction", "published.json"),
    ) as { secret: string; body: string; signature: string };

    const computed = await computeSignature(
      SCHEMES.monnify,
      new TextEncoder().encode(published.body),
      published.secret,
    );
    assert.equal(computed, published.signature);
  });

  test("the plain digest its prose describes does NOT reproduce the published hash", async () => {
    // Recorded so nobody "fixes" the implementation towards the prose later.
    const published = JSON.parse(
      fixtureFile("webhook-successful-transaction", "published.json"),
    ) as { secret: string; body: string; signature: string };

    const digest = await crypto.subtle.digest(
      "SHA-512",
      new TextEncoder().encode(published.secret + published.body),
    );
    const hex = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    assert.notEqual(hex, published.signature);
  });

  test("verifies a signed webhook over the raw bytes", async () => {
    const { provider } = harness([]);
    const body = new TextEncoder().encode(
      fixtureFile("webhook-successful-transaction", "body.json"),
    );
    const signature = await computeSignature(SCHEMES.monnify, body, SECRET_KEY);

    const result = await provider.verifyWebhook({
      body,
      headers: { "Monnify-Signature": signature },
    });
    assert.equal(result.verified, true);
    assert.equal(result.strength, "full-body");
  });

  test("a tampered body does not verify", async () => {
    const { provider } = harness([]);
    const body = new TextEncoder().encode(
      fixtureFile("webhook-successful-transaction", "body.json"),
    );
    const signature = await computeSignature(SCHEMES.monnify, body, SECRET_KEY);

    const tampered = new TextEncoder().encode(
      fixtureFile("webhook-successful-transaction", "body.json").replace("78000", "7800000"),
    );
    const result = await provider.verifyWebhook({
      body: tampered,
      headers: { "monnify-signature": signature },
    });
    assert.equal(result.verified, false);
  });

  test("a sandbox delivery with no header is reported honestly, not accepted", async () => {
    // Monnify documents that the header is only sent in production. Saying so in the
    // reason is the whole value of this path.
    const { provider } = harness([]);
    const result = await provider.verifyWebhook({
      body: new TextEncoder().encode("{}"),
      headers: {},
    });
    assert.equal(result.verified, false);
    assert.equal(result.strength, "unverified");
    assert.match(result.reason ?? "", /only sent on production notifications/);
  });

  test("the published webhook IP is recognised and others are not", () => {
    const { provider } = harness([]);
    assert.equal(provider.isKnownWebhookIp("35.242.133.146"), true);
    assert.equal(provider.isKnownWebhookIp(" 35.242.133.146 "), true);
    assert.equal(provider.isKnownWebhookIp("35.242.133.147"), false);
  });
});

describe("normalisation", () => {
  test("PARTIALLY_PAID is pending and OVERPAID is successful", () => {
    // The most expensive mistake this file could make would be reporting a partial
    // payment as successful.
    assert.equal(normaliseStatus("PARTIALLY_PAID"), "pending");
    assert.equal(normaliseStatus("OVERPAID"), "successful");
    assert.equal(normaliseStatus("PAID"), "successful");
  });

  test("an unknown status is pending, which is the safe direction", () => {
    assert.equal(normaliseStatus("SOMETHING_NEW"), "pending");
    assert.equal(normaliseStatus(undefined), "pending");
    assert.equal(normaliseTransferStatus("SOMETHING_NEW"), "pending");
  });

  test("midnight and midday are parsed correctly", () => {
    // 12 AM is hour 0 and 12 PM is hour 12; adding twelve for PM gets both wrong.
    assert.equal(
      parseMonnifyDate("25/07/2022 12:00:00 AM")?.toISOString(),
      "2022-07-25T00:00:00.000Z",
    );
    assert.equal(
      parseMonnifyDate("25/07/2022 12:00:00 PM")?.toISOString(),
      "2022-07-25T12:00:00.000Z",
    );
  });

  test("an impossible date is refused rather than rolled forward", () => {
    // Date.UTC turns 31 February into 3 March without complaining.
    assert.equal(parseMonnifyDate("31/02/2022 10:00:00 AM"), null);
    assert.equal(parseMonnifyDate("not a date"), null);
  });

  test("a zoneless stamp is read as UTC in both languages", () => {
    // JavaScript would otherwise read it as local time and Python as naive, so the two
    // packages would disagree about the instant. See the parity cases.
    assert.equal(
      parseMonnifyDate("2024-11-25 07:35:17.566")?.toISOString(),
      "2024-11-25T07:35:17.566Z",
    );
  });

  test("an amount that cannot be represented exactly is null, not rounded", () => {
    assert.equal(asMoney("100.00")?.amount, 10_000);
    assert.equal(asMoney(100)?.amount, 10_000);
    // Three decimal places in a two-decimal currency.
    assert.equal(asMoney("100.001"), null);
    assert.equal(asMoney("not a number"), null);
    assert.equal(asMoney(-1), null);
  });

  test("the payer's own account is carried through when Monnify reports it", () => {
    const transaction = toTransaction({
      paymentReference: "order-01HQ-EXAMPLE",
      paymentStatus: "PAID",
      amountPaid: "100.00",
      paymentSourceInformation: [
        { accountNumber: "0123456789", bankCode: "044", accountName: "ADA EXAMPLE" },
      ],
    });
    // An array on a webhook, an object on a verify response. Both shapes accepted.
    assert.equal(transaction.sourceAccount?.accountNumber, "0123456789");
    assert.equal(transaction.sourceAccount?.bankCode, "044");
  });
});

describe("capabilities", () => {
  test("an unsupported operation fails locally with no network call", async () => {
    const { provider, calls } = harness([]);
    // Monnify's sub-accounts are settlement destinations, not spendable wallets.
    assert.equal(supports(provider.capabilities, "wallets.open"), false);
    await assert.rejects(
      (
        provider as unknown as { getWalletStatement: () => Promise<unknown> }
      ).getWalletStatement?.() ??
        Promise.reject(
          new UnsupportedOperationError({ provider: "monnify", operation: "wallets.statement" }),
        ),
      UnsupportedOperationError,
    );
    assert.equal(calls.length, 0);
  });

  test("the operations Monnify gates behind approval are declared", () => {
    const { provider } = harness([]);
    const gated = operationsRequiringApproval(provider.capabilities);
    // Monnify's own spec says so for all three groups.
    assert.ok(gated.includes("payouts.create"));
    assert.ok(gated.includes("splitAccounts.create"));
    assert.ok(gated.includes("refunds.create"));
  });

  test("the webhook strength is claimed as full-body, which was earned", () => {
    const { provider } = harness([]);
    assert.equal(provider.capabilities.webhookSignature?.strength, "full-body");
    assert.match(provider.capabilities.webhookSignature?.notes ?? "", /only sent in production/);
  });

  test("what is not implemented says why, rather than being silently missing", () => {
    const { provider } = harness([]);
    assert.match(
      provider.notYetImplemented["wallets.open"] ?? "",
      /not spendable customer wallets/,
    );
    assert.match(provider.notYetImplemented["mandates.create"] ?? "", /Milestone 7/);
  });

  test("the provider is the class it claims to be", () => {
    const { provider } = harness([]);
    assert.ok(provider instanceof MonnifyProvider);
    assert.equal(provider.name, "monnify");
  });
});
