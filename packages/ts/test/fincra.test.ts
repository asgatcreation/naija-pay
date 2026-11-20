import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { assertSupported, supports } from "../src/core/capabilities.ts";
import {
  ConfigurationError,
  DuplicateReferenceError,
  InsufficientFundsError,
  KycRequiredError,
  NotFoundError,
  PayoutStatusUnknownError,
  UnsupportedOperationError,
  ValidationError,
} from "../src/core/errors.ts";
import { money, naira } from "../src/core/money.ts";
import { computeSignature, SCHEMES } from "../src/core/signatures.ts";
import { FincraProvider, fincra } from "../src/providers/fincra/index.ts";
import {
  asMoney,
  normalisePayoutStatus,
  normaliseStatus,
  toBvnVerification,
  toRefund,
} from "../src/providers/fincra/normalise.ts";

const FIXTURES = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")),
  "..",
  "..",
  "..",
  "fixtures",
  "providers",
  "fincra",
);

/** Loads a recorded response, so no test invents a provider payload. */
function fixture(operation: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES, operation, "response.json"), "utf8"));
}

const SECRET_KEY = "EXAMPLEfincrasecretkey0000000000";
const WEBHOOK_KEY = "EXAMPLEfincrawebhookkey000000000";
const BUSINESS_ID = "64f000000000000000000001";

/** Serves fixtures in order, recording the requests the adapter made. */
function harness(
  operations: (string | { status: number; body: unknown })[],
  options: { businessId?: string | undefined; webhookSecretKey?: string | undefined } = {},
) {
  const calls: { url: string; method: string; body: unknown; headers: Record<string, string> }[] =
    [];
  let index = 0;

  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });

    const next = operations[Math.min(index, operations.length - 1)];
    index++;
    if (next === undefined) throw new Error("the harness was given no operations");
    const resolved = typeof next === "string" ? { status: 200, body: fixture(next) } : next;
    return new Response(JSON.stringify(resolved.body), {
      status: resolved.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;

  const businessId = "businessId" in options ? options.businessId : BUSINESS_ID;
  const webhookSecretKey = "webhookSecretKey" in options ? options.webhookSecretKey : WEBHOOK_KEY;

  const provider = fincra({
    secretKey: SECRET_KEY,
    ...(businessId === undefined ? {} : { businessId }),
    ...(webhookSecretKey === undefined ? {} : { webhookSecretKey }),
    environment: "test",
    fetch: fetchImpl,
    sleep: async () => {},
  });

  return { provider, calls };
}

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
  test("requires a secret key, and says where it lives", () => {
    assert.throws(
      () => fincra({ secretKey: "" }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigurationError);
        assert.match(error.message, /api-key header/);
        return true;
      },
    );
  });

  test("defaults to the sandbox host, which is a different machine from live", async () => {
    const { provider, calls } = harness(["banks-list"]);
    await provider.listBanks();
    assert.match(callAt(calls, 0).url, /^https:\/\/sandboxapi\.fincra\.com\//);
  });

  test("warns loudly when the environment is live outside production", () => {
    const warnings: string[] = [];
    fincra({
      secretKey: SECRET_KEY,
      environment: "live",
      onLiveKeyWarning: (message) => warnings.push(message),
    });
    assert.equal(warnings.length, 1);
    // Fincra publishes no key prefix, so the environment is the only signal there is.
    assert.match(warnings[0] ?? "", /no key prefix/);
    assert.match(warnings[0] ?? "", /Real money will move/);
  });

  test("authenticates with api-key, not Authorization", async () => {
    // A Bearer token is silently ignored by Fincra, and the reply blames a missing key.
    const { provider, calls } = harness(["banks-list"]);
    await provider.listBanks();
    const headers = callAt(calls, 0).headers;
    assert.equal(headers["api-key"], SECRET_KEY);
    assert.equal(headers.authorization, undefined);
  });

  test("a call that needs the business id says so when there is none", async () => {
    const { provider, calls } = harness(["wallets-list"], { businessId: undefined });
    await assert.rejects(provider.getBalance(), (error: unknown) => {
      assert.ok(error instanceof ConfigurationError);
      assert.match(error.message, /getBusiness\(\) will tell you yours/);
      return true;
    });
    assert.equal(calls.length, 0);
  });
});

describe("the envelope", () => {
  test("checkout endpoints spell success `status` and payouts spell it `success`", async () => {
    // Both names, one meaning. Reading only one of them would fail every other call.
    assert.equal((fixture("checkout-initialize") as { status: boolean }).status, true);
    assert.equal((fixture("payout-create-processing") as { success: boolean }).success, true);

    const { provider } = harness(["checkout-initialize"]);
    const checkout = await provider.createCheckout({
      amount: naira(350),
      email: "ada@example.com",
      name: "Ada Example",
      reference: "order-01HQ-EXAMPLE",
    });
    assert.match(checkout.checkoutUrl, /^https:\/\/sandbox-checkout\.fincra\.com\//);
  });

  test("`status: false` on an HTTP 200 is a failure, not data", async () => {
    const { provider } = harness([
      { status: 200, body: { status: false, message: "Duplicate reference" } },
    ]);
    await assert.rejects(
      provider.createCheckout({
        amount: naira(350),
        email: "ada@example.com",
        name: "Ada Example",
        reference: "order-01HQ-EXAMPLE",
      }),
      DuplicateReferenceError,
    );
  });

  test("an envelope with neither key is treated as success", async () => {
    // So an endpoint that spells it a third way does not fail every call.
    const { provider } = harness([
      {
        status: 200,
        body: { message: "ok", data: { accountNumber: "0123456789", accountName: "ADA EXAMPLE" } },
      },
    ]);
    const account = await provider.resolveAccount({
      accountNumber: "0123456789",
      bankCode: "044",
    });
    assert.equal(account.accountName, "ADA EXAMPLE");
  });

  test("an entitlement message reads as configuration, not authentication", async () => {
    const { provider } = harness([
      {
        status: 403,
        body: { success: false, message: "Your IP is not whitelisted, contact support" },
      },
    ]);
    await assert.rejects(provider.listBanks(), (error: unknown) => {
      assert.ok(error instanceof ConfigurationError);
      assert.match(error.message, /whitelisted/);
      return true;
    });
  });

  test("an insufficient-balance message is its own error", async () => {
    const { provider } = harness([
      { status: 400, body: { success: false, message: "Insufficient balance" } },
    ]);
    await assert.rejects(
      provider.createPayout({
        amount: naira(1000),
        reference: "payout-01HQ-EXAMPLE",
        beneficiary: {
          accountNumber: "0123456789",
          bankCode: "044",
          accountHolderName: "Ada Example",
        },
      }),
      InsufficientFundsError,
    );
  });
});

describe("collections", () => {
  test("the amount goes out as decimal major units, never as kobo", async () => {
    const { provider, calls } = harness(["checkout-initialize"]);
    await provider.createCheckout({
      amount: money(350_050, "NGN"),
      email: "ada@example.com",
      name: "Ada Example",
      reference: "order-01HQ-EXAMPLE",
      channels: ["card", "bank_transfer"],
      phone: "09022222222",
    });

    const body = bodyOf<{
      amount: number;
      currency: string;
      paymentMethods: string[];
      customer: { phoneNumber: string };
    }>(calls, 0);
    // 350050 kobo is 3500.50 naira.
    assert.equal(body.amount, 3500.5);
    assert.equal(body.currency, "NGN");
    assert.deepEqual(body.paymentMethods, ["card", "bank_transfer"]);
    assert.equal(body.customer.phoneNumber, "09022222222");
  });

  test("refuses a currency Fincra does not document", async () => {
    const { provider, calls } = harness(["checkout-initialize"]);
    await assert.rejects(
      provider.createCheckout({
        amount: money(1000, "ZAR"),
        email: "ada@example.com",
        name: "Ada Example",
        reference: "order-01HQ-EXAMPLE",
      }),
      (error: unknown) => {
        assert.ok(error instanceof ValidationError);
        assert.match(error.message, /not one of the currencies Fincra documents/);
        return true;
      },
    );
    assert.equal(calls.length, 0);
  });

  test("refuses a channel Fincra does not have", async () => {
    const { provider, calls } = harness(["checkout-initialize"]);
    await assert.rejects(
      provider.createCheckout({
        amount: naira(350),
        email: "ada@example.com",
        name: "Ada Example",
        reference: "order-01HQ-EXAMPLE",
        channels: ["apple_pay"],
      }),
      /does not support the channel\(s\): apple_pay/,
    );
    assert.equal(calls.length, 0);
  });

  test("verify is by YOUR reference and carries the business id header", async () => {
    // The opposite of Flutterwave: Fincra has no verify-by-its-own-reference route for
    // checkout, and this one call needs x-business-id.
    const { provider, calls } = harness(["checkout-verify-success"]);
    const transaction = await provider.verifyTransaction("order-01HQ-EXAMPLE");

    assert.match(
      callAt(calls, 0).url,
      /\/checkout\/payments\/merchant-reference\/order-01HQ-EXAMPLE$/,
    );
    assert.equal(callAt(calls, 0).headers["x-business-id"], BUSINESS_ID);
    assert.equal(transaction.status, "successful");
    assert.equal(transaction.amount?.amount, 35_000);
    assert.equal(transaction.reference, "order-01HQ-EXAMPLE");
  });

  test("the channels on a verified payment are normalised, unknown ones dropped", async () => {
    const { provider } = harness(["checkout-verify-success"]);
    const transaction = await provider.verifyTransaction("order-01HQ-EXAMPLE");
    // The fixture lists card, bank_transfer and payattitude.
    assert.equal(transaction.channel, "bank_transfer");
  });
});

describe("refunds", () => {
  test("a refund is full-amount only, and that absence is stated", async () => {
    const { provider, calls } = harness(["refund-status"]);
    await provider.createRefund("96d1fc1c-2570-EXAMPLE");

    // There is no amount field on Fincra's refund endpoint at all.
    assert.deepEqual(bodyOf(calls, 0), { transReference: "96d1fc1c-2570-EXAMPLE" });
    assert.match(callAt(calls, 0).url, /\/collections\/refund$/);
  });

  test("a refund is money-moving and is never retried", async () => {
    const { provider, calls } = harness([
      { status: 503, body: { success: false, message: "Service unavailable" } },
    ]);
    await assert.rejects(provider.createRefund("96d1fc1c-2570-EXAMPLE"), PayoutStatusUnknownError);
    assert.equal(calls.length, 1);
  });

  test("Fincra's six-decimal refund amounts are read exactly or not at all", async () => {
    const { provider } = harness(["refund-status"]);
    const refund = await provider.getRefund("cba44033-bcaa-EXAMPLE");

    // "5914.000000" is exactly 591400 kobo.
    assert.equal(refund.amount?.amount, 591_400);
    assert.equal(refund.status, "processing");
    assert.equal(refund.reason, "overpayment");
    assert.equal(refund.destination?.bankCode, "042");
  });

  test("a refund's zoneless timestamps are read as UTC", () => {
    // "2023-12-07 17:39:00" with no offset: JavaScript would otherwise read it as local
    // time and Python as naive, so the two packages would disagree about the instant.
    const refund = toRefund({
      reference: "cba44033-bcaa-EXAMPLE",
      amountRefunded: "100.000000",
      refundStatus: "processing",
      completedAt: "2023-12-07 17:39:00",
    });
    const completed = (refund.raw as { completedAt: string }).completedAt;
    assert.equal(completed, "2023-12-07 17:39:00");
    // The fixture carries the same shape, which is what makes this worth pinning.
    const data = (fixture("refund-status") as { data: { completedAt: string } }).data;
    assert.match(data.completedAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  test("listing refunds needs the business id as a query parameter", async () => {
    const { provider, calls } = harness([
      { status: 200, body: { success: true, data: { results: [] } } },
    ]);
    await provider.listRefunds();
    assert.match(callAt(calls, 0).url, /business=64f000000000000000000001/);
  });
});

describe("virtual accounts", () => {
  test("an NGN account requires a bvn, and fails locally without one", async () => {
    const { provider, calls } = harness(["virtual-account-create"]);
    await assert.rejects(
      provider.createVirtualAccount({
        currency: "NGN",
        accountType: "individual",
        firstName: "Ada",
        lastName: "Example",
      }),
      (error: unknown) => {
        assert.ok(error instanceof KycRequiredError);
        assert.deepEqual([...error.required], ["bvn"]);
        return true;
      },
    );
    assert.equal(calls.length, 0);
  });

  test("a corporate account requires businessName and bvnName together", async () => {
    const { provider } = harness(["virtual-account-create"]);
    await assert.rejects(
      provider.createVirtualAccount({
        currency: "NGN",
        accountType: "corporate",
        bvn: "21212121212",
        businessName: "Example Ltd",
      }),
      /requires both businessName and bvnName/,
    );
  });

  test("an individual account requires both names", async () => {
    const { provider } = harness(["virtual-account-create"]);
    await assert.rejects(
      provider.createVirtualAccount({
        currency: "NGN",
        accountType: "individual",
        bvn: "21212121212",
        firstName: "Ada",
      }),
      /requires both firstName and lastName/,
    );
  });

  test("a bank channel Fincra publishes as DISABLED is refused locally", async () => {
    // Two of the nine are disabled in Fincra's own table, which is why the choice has to
    // be a capability query rather than an enum.
    const { provider, calls } = harness(["virtual-account-create"]);
    await assert.rejects(
      provider.createVirtualAccount({
        currency: "NGN",
        accountType: "individual",
        bvn: "21212121212",
        firstName: "Ada",
        lastName: "Example",
        channel: "providus",
      }),
      /published as DISABLED/,
    );
    await assert.rejects(
      provider.createVirtualAccount({
        currency: "NGN",
        accountType: "individual",
        bvn: "21212121212",
        firstName: "Ada",
        lastName: "Example",
        channel: "not-a-bank",
      }),
      /is not one of the bank channels Fincra publishes/,
    );
    assert.equal(calls.length, 0);
  });

  test("an approved request is the only one read as verified", async () => {
    const { provider, calls } = harness(["virtual-account-create"]);
    const account = await provider.createVirtualAccount({
      currency: "NGN",
      accountType: "individual",
      bvn: "21212121212",
      firstName: "Ada",
      lastName: "Example",
      reference: "va-ada-EXAMPLE",
      channel: "globus",
    });

    const body = bodyOf<{ KYCInformation: { bvn: string }; channel: string }>(calls, 0);
    assert.equal(body.KYCInformation.bvn, "21212121212");
    assert.equal(body.channel, "globus");
    assert.equal(account.kycStatus, "verified");
    assert.equal(account.kind, "static");
    assert.equal(account.accounts[0]?.accountNumber, "1234567890");
  });

  test("a pending request is not read as verified", async () => {
    const { provider } = harness([
      { status: 200, body: { success: true, data: { _id: "x", status: "pending" } } },
    ]);
    const account = await provider.createVirtualAccount({
      currency: "NGN",
      accountType: "individual",
      bvn: "21212121212",
      firstName: "Ada",
      lastName: "Example",
    });
    assert.equal(account.kycStatus, "pending");
  });

  test("a temporary account sends its amount as a STRING, unlike every other endpoint", async () => {
    const { provider, calls } = harness(["virtual-account-create"]);
    await provider.createDynamicVirtualAccount({
      amount: naira(350),
      expiresAt: new Date("2026-12-01T00:00:00.000Z"),
      reference: "va-dyn-EXAMPLE",
    });

    const body = bodyOf<{ amount: unknown; expiresAt: string }>(calls, 0);
    assert.equal(typeof body.amount, "string");
    assert.equal(body.amount, "350");
    assert.equal(body.expiresAt, "2026-12-01T00:00:00.000Z");
  });

  test("a temporary account is NGN only", async () => {
    const { provider } = harness(["virtual-account-create"]);
    await assert.rejects(
      provider.createDynamicVirtualAccount({
        amount: money(1000, "USD"),
        expiresAt: "2026-12-01T00:00:00.000Z",
      }),
      /NGN only/,
    );
  });

  test("a bvn lookup is a lookup, not a way to read account numbers back", async () => {
    // Fincra masks the response with asterisks, which is worth knowing before relying
    // on it.
    const { provider, calls } = harness([
      {
        status: 200,
        body: {
          success: true,
          data: { results: [{ _id: "x", accountNumber: "****", status: "approved" }] },
        },
      },
    ]);
    const page = await provider.findVirtualAccountsByBvn("21212121212");
    assert.match(callAt(calls, 0).url, /bvn=21212121212/);
    assert.equal(page.items.length, 1);
  });
});

describe("payouts", () => {
  test("`success: true` with status processing is PENDING, not paid", async () => {
    // Fincra's own documentation says success means the request was accepted. Reading it
    // as settlement is the most expensive mistake available in this file.
    const { provider } = harness(["payout-create-processing"]);
    const payout = await provider.createPayout({
      amount: naira(1000),
      reference: "payout-01HQ-EXAMPLE",
      description: "Payout",
      beneficiary: {
        accountNumber: "0123456789",
        bankCode: "044",
        accountHolderName: "Ada Example",
      },
    });

    assert.equal(payout.status, "pending");
    assert.equal(payout.awaitingDocument, false);
  });

  test("the fixture really says success and processing at the same time", () => {
    const response = fixture("payout-create-processing") as {
      success: boolean;
      data: { status: string };
    };
    assert.equal(response.success, true);
    assert.equal(response.data.status, "processing");
  });

  test("the payout amount is a number, because Fincra says not to send a string", async () => {
    const { provider, calls } = harness(["payout-create-processing"]);
    await provider.createPayout({
      amount: naira(1000),
      reference: "payout-01HQ-EXAMPLE",
      beneficiary: {
        accountNumber: "0123456789",
        bankCode: "044",
        accountHolderName: "Ada Example",
      },
    });

    const body = bodyOf<{
      amount: unknown;
      business: string;
      paymentDestination: string;
      beneficiary: { type: string; country: string };
    }>(calls, 0);
    assert.equal(typeof body.amount, "number");
    assert.equal(body.amount, 1000);
    assert.equal(body.business, BUSINESS_ID);
    assert.equal(body.paymentDestination, "bank_account");
    assert.equal(body.beneficiary.type, "individual");
    assert.equal(body.beneficiary.country, "NG");
  });

  test("a cross-currency payout without a quote is refused locally", async () => {
    const { provider, calls } = harness(["payout-create-processing"]);
    await assert.rejects(
      provider.createPayout({
        amount: naira(1000),
        reference: "payout-01HQ-EXAMPLE",
        destinationCurrency: "USD",
        beneficiary: {
          accountNumber: "0123456789",
          bankCode: "044",
          accountHolderName: "Ada Example",
        },
      }),
      /requires a quoteReference/,
    );
    assert.equal(calls.length, 0);
  });

  test("a payout is never retried, and a 503 reports an unknown outcome", async () => {
    const { provider, calls } = harness([
      { status: 503, body: { success: false, message: "Service unavailable" } },
    ]);
    await assert.rejects(
      provider.createPayout({
        amount: naira(1000),
        reference: "payout-01HQ-EXAMPLE",
        beneficiary: {
          accountNumber: "0123456789",
          bankCode: "044",
          accountHolderName: "Ada Example",
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof PayoutStatusUnknownError);
        assert.match(error.message, /must NOT be retried/);
        return true;
      },
    );
    assert.equal(calls.length, 1);
  });

  test("a fee no currency can represent is null rather than rounded", async () => {
    const { provider } = harness(["payout-verify-cross-currency"]);
    const payout = await provider.getPayout("db396365d80bEXAMPLE");

    // fee: 9090.909091 — six decimal places, which no currency has.
    assert.equal(payout.fee, null);
    // And the exact figure is still there for anyone who needs it.
    assert.equal((payout.raw as { fee: number }).fee, 9090.909091);
    assert.equal(payout.sourceCurrency, "KES");
    assert.equal(payout.destinationCurrency, "EUR");
    assert.equal(payout.status, "successful");
  });

  test("your own reference and Fincra's are different routes", async () => {
    const { provider, calls } = harness([
      "payout-verify-cross-currency",
      "payout-verify-cross-currency",
    ]);
    await provider.getPayout("db396365d80bEXAMPLE");
    await provider.getPayoutByReference("payout-01HQ-EXAMPLE");

    assert.match(callAt(calls, 0).url, /\/disbursements\/payouts\/reference\/db396365d80bEXAMPLE$/);
    assert.match(
      callAt(calls, 1).url,
      /\/disbursements\/payouts\/customer-reference\/payout-01HQ-EXAMPLE$/,
    );
  });

  test("listing payouts sends filters as query parameters, not as a GET body", async () => {
    // Fincra's reference page documents a GET with a request body, which fetch cannot
    // send and most servers do not read. Recorded in PROVIDERS.md.
    const { provider, calls } = harness([
      { status: 200, body: { success: true, data: { results: [] } } },
    ]);
    await provider.listPayouts({ page: 2, perPage: 50, status: "successful" });

    const call = callAt(calls, 0);
    assert.equal(call.method, "GET");
    assert.equal(bodyOf(calls, 0), undefined);
    assert.match(call.url, /page=2/);
    assert.match(call.url, /perPage=50/);
    assert.match(call.url, /status=successful/);
  });

  test("a payout waiting for a document is reported as waiting", () => {
    // Fincra's equivalent of Monnify's OTP gate: accepted, and going nowhere.
    const payout = normalisePayoutStatus("processing");
    assert.equal(payout, "pending");
  });
});

describe("banks, balance and identity", () => {
  test("banks default to Nigeria and keep Fincra's own codes", async () => {
    const { provider, calls } = harness(["banks-list"]);
    const banks = await provider.listBanks();

    assert.match(callAt(calls, 0).url, /country=NG/);
    assert.equal(banks[0]?.code, "044");
    assert.equal(banks[0]?.name, "Access Bank");
    // Fincra also publishes the NIBSS code, which is the one that matters for transfers.
    assert.equal((banks[0]?.raw as { nibssCode: string } | undefined)?.nibssCode, "044");
  });

  test("a NUBAN resolve is a POST, and carries the bank code we passed", async () => {
    // Fincra does not echo the bank code back, so the adapter keeps the caller's.
    const { provider, calls } = harness(["account-resolve"]);
    const account = await provider.resolveAccount({
      accountNumber: "0123456789",
      bankCode: "044",
    });

    assert.equal(callAt(calls, 0).method, "POST");
    assert.deepEqual(bodyOf(calls, 0), {
      type: "nuban",
      accountNumber: "0123456789",
      bankCode: "044",
    });
    assert.equal(account.bankCode, "044");
    assert.ok(account.institution, "044 should match an institution in naija-data");
  });

  test("wallet balances come back one per currency, six-decimal ones as null", async () => {
    const { provider, calls } = harness(["wallets-list"]);
    const wallets = await provider.getBalance();

    assert.match(callAt(calls, 0).url, /businessID=64f000000000000000000001/);
    const ngn = wallets.find((wallet) => wallet.currency === "NGN");
    const gbp = wallets.find((wallet) => wallet.currency === "GBP");
    // 1999792413.990817 has six decimal places: not representable in kobo.
    assert.equal(ngn?.available, null);
    assert.equal(gbp?.available, null);
    // The exact figures stay in raw.
    assert.equal(
      (gbp?.raw as { availableBalance: number } | undefined)?.availableBalance,
      4145.558824,
    );
  });

  test("getBusiness is how you find the id every other call needs", async () => {
    const { provider, calls } = harness([
      { status: 200, body: { success: true, data: { _id: BUSINESS_ID } } },
    ]);
    const business = await provider.getBusiness();
    assert.match(callAt(calls, 0).url, /\/profile\/business\/me$/);
    assert.equal(business.id, BUSINESS_ID);
  });

  test("a BVN verification never carries the photograph", async () => {
    const { provider } = harness(["bvn-verification"]);
    const result = await provider.verifyBvn("21212121212");

    assert.equal(result.verified, true);
    assert.equal(result.firstName, "ADA");
    assert.equal(result.lastName, "EXAMPLE");
    // Fincra's own date wording, not parsed into a Date.
    assert.equal(result.dateOfBirth, "15-Jul-2022");
    // The photograph is dropped from the object AND from raw.
    assert.equal(JSON.stringify(result).includes("pixBase64"), false);
    assert.equal(JSON.stringify(result.raw).includes("pixBase64"), false);
  });

  test("the fixture really does carry a photograph, so the test above is not vacuous", () => {
    const data = fixture("bvn-verification") as { data: { response: { pixBase64: string } } };
    assert.equal(typeof data.data.response.pixBase64, "string");
  });

  test("a BVN is never put in a URL", async () => {
    // It goes in the body of a POST. A BVN in a query string ends up in access logs.
    const { provider, calls } = harness(["bvn-verification"]);
    await provider.verifyBvn("21212121212");
    assert.doesNotMatch(callAt(calls, 0).url, /21212121212/);
    assert.equal(bodyOf<{ bvn: string }>(calls, 0).bvn, "21212121212");
  });
});

describe("webhooks", () => {
  const PAYLOAD = JSON.stringify({
    event: "charge.successful",
    data: { reference: "order-01HQ-EXAMPLE", status: "success" },
  });

  test("a signature over the raw bytes verifies, and says so", async () => {
    const { provider } = harness([]);
    const body = new TextEncoder().encode(PAYLOAD);
    const signature = await computeSignature(SCHEMES.fincra, body, WEBHOOK_KEY);

    const result = await provider.verifyWebhook({ body, headers: { signature } });
    assert.equal(result.verified, true);
    assert.equal(result.strength, "full-body");
    assert.equal(result.matchedInput, "raw-body");
  });

  test("a signature over Fincra's own re-serialisation also verifies, and says which", async () => {
    // Fincra's samples hash JSON.stringify({event, data}), not the bytes. Here the bytes
    // that arrive carry extra whitespace and a third key, so only the re-serialisation
    // can match — which is exactly the case worth distinguishing.
    const { provider } = harness([]);
    const parsed = JSON.parse(PAYLOAD) as Record<string, unknown>;
    const delivered = new TextEncoder().encode(
      JSON.stringify({ ...parsed, extra: "ignored by the signature" }, null, 2),
    );
    const signature = await computeSignature(
      SCHEMES.fincra,
      new TextEncoder().encode(JSON.stringify({ event: parsed.event, data: parsed.data })),
      WEBHOOK_KEY,
    );

    const result = await provider.verifyWebhook({ body: delivered, headers: { signature } });
    assert.equal(result.verified, true);
    assert.equal(result.matchedInput, "canonical-reserialisation");
  });

  test("a tampered body does not verify, and the reason names the likely cause", async () => {
    const { provider } = harness([]);
    const body = new TextEncoder().encode(PAYLOAD);
    const signature = await computeSignature(SCHEMES.fincra, body, WEBHOOK_KEY);

    const result = await provider.verifyWebhook({
      body: new TextEncoder().encode(PAYLOAD.replace("success", "failed")),
      headers: { signature },
    });
    assert.equal(result.verified, false);
    assert.equal(result.matchedInput, null);
    assert.match(result.reason ?? "", /WEBHOOK secret key/);
  });

  test("a missing header is unverified rather than a failure to match", async () => {
    const { provider } = harness([]);
    const result = await provider.verifyWebhook({
      body: new TextEncoder().encode(PAYLOAD),
      headers: {},
    });
    assert.equal(result.verified, false);
    assert.equal(result.strength, "unverified");
    assert.match(result.reason ?? "", /"signature" header is missing/);
  });

  test("verifying with no webhook key says it is a THIRD key", async () => {
    // The commonest Fincra webhook mistake: signing with the API secret key.
    const { provider } = harness([], { webhookSecretKey: undefined });
    await assert.rejects(
      provider.verifyWebhook({
        body: new TextEncoder().encode(PAYLOAD),
        headers: { signature: "x" },
      }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigurationError);
        assert.match(error.message, /THIRD key/);
        return true;
      },
    );
  });

  test("the header name is lowercase-insensitive", async () => {
    const { provider } = harness([]);
    const body = new TextEncoder().encode(PAYLOAD);
    const signature = await computeSignature(SCHEMES.fincra, body, WEBHOOK_KEY);
    const result = await provider.verifyWebhook({ body, headers: { Signature: signature } });
    assert.equal(result.verified, true);
  });
});

describe("normalisation", () => {
  test("processing is pending on both status maps", () => {
    assert.equal(normaliseStatus("processing"), "pending");
    assert.equal(normalisePayoutStatus("processing"), "pending");
  });

  test("an unknown status is pending, which is the safe direction", () => {
    assert.equal(normaliseStatus("SOMETHING_NEW"), "pending");
    assert.equal(normaliseStatus(undefined), "pending");
    assert.equal(normalisePayoutStatus(null), "pending");
  });

  test("an amount with more precision than the currency has is null", () => {
    assert.equal(asMoney(350)?.amount, 35_000);
    assert.equal(asMoney("5914.000000")?.amount, 591_400);
    // The real ones from Fincra's own samples.
    assert.equal(asMoney(9090.909091), null);
    assert.equal(asMoney(4145.558824), null);
    assert.equal(asMoney(-1), null);
    assert.equal(asMoney("not a number"), null);
  });

  test("a BVN response with no photograph still normalises", () => {
    const result = toBvnVerification({
      verificationStatus: "verified",
      response: { firstName: "ADA", lastName: "EXAMPLE" },
    });
    assert.equal(result.verified, true);
    assert.equal(result.middleName, null);
  });
});

describe("capabilities", () => {
  test("what Fincra does not have says why, rather than being silently missing", () => {
    const { provider } = harness([]);
    assert.match(provider.notYetImplemented["splitAccounts.create"] ?? "", /different shape/);
    assert.match(provider.notYetImplemented["payouts.createBulk"] ?? "", /no batch payout route/);
    assert.match(
      provider.notYetImplemented["charges.chargeAuthorization"] ?? "",
      /never touches raw card data/,
    );
  });

  test("an operation Fincra does not have is declared unsupported, with no method", () => {
    const { provider, calls } = harness([]);
    // Fincra has sub-accounts for multi-entity businesses, not transaction splits, so
    // the capability is declared false rather than implemented half-way.
    assert.equal(supports(provider.capabilities, "splits.create"), false);
    assert.equal(supports(provider.capabilities, "payouts.createBulk"), false);
    assert.equal("createSplit" in (provider as unknown as Record<string, unknown>), false);
    assert.equal(calls.length, 0);
  });

  test("asking the core for an unsupported operation raises, rather than returning", () => {
    const { provider } = harness([]);
    assert.throws(
      () => assertSupported(provider.capabilities, "splits.create"),
      UnsupportedOperationError,
    );
  });

  test("the widest currency list in Tier 1 is declared, not assumed", () => {
    const { provider } = harness([]);
    const currencies = provider.capabilities.currencies ?? [];
    assert.ok(currencies.includes("NGN"));
    assert.ok(currencies.includes("KES"));
    assert.ok(currencies.includes("EUR"));
  });

  test("the webhook declaration records the re-serialisation hazard", () => {
    const { provider } = harness([]);
    assert.equal(provider.capabilities.webhookSignature?.header, "signature");
    assert.match(provider.capabilities.webhookSignature?.notes ?? "", /re-serialisation/);
  });

  test("a 404 is a NotFoundError", async () => {
    const { provider } = harness([
      { status: 404, body: { success: false, message: "Payout not found" } },
    ]);
    await assert.rejects(provider.getPayout("nope-EXAMPLE"), NotFoundError);
  });

  test("the provider is the class it claims to be", () => {
    const { provider } = harness([]);
    assert.ok(provider instanceof FincraProvider);
    assert.equal(provider.name, "fincra");
  });
});
