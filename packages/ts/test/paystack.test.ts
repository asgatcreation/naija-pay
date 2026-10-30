import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { assertSupported, supports } from "../src/core/capabilities.ts";
import {
  ConfigurationError,
  DuplicateReferenceError,
  KycRequiredError,
  PayoutStatusUnknownError,
  UnsupportedOperationError,
  ValidationError,
} from "../src/core/errors.ts";
import { money, naira } from "../src/core/money.ts";
import { computeSignature, SCHEMES } from "../src/core/signatures.ts";
import { PaystackProvider, paystack } from "../src/providers/paystack/index.ts";

const FIXTURES = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")),
  "..",
  "..",
  "..",
  "fixtures",
  "providers",
  "paystack",
);

/** Loads a recorded response, so no test invents a provider payload. */
function fixture(operation: string): { request: unknown; response: unknown } {
  return {
    request: JSON.parse(readFileSync(path.join(FIXTURES, operation, "request.json"), "utf8")),
    response: JSON.parse(readFileSync(path.join(FIXTURES, operation, "response.json"), "utf8")),
  };
}

const TEST_KEY = "sk_test_EXAMPLEpaystack";

/**
 * Serves fixtures in order, recording the requests the adapter made so they can be
 * asserted against. No network, no keys.
 */
function harness(operations: (string | { status: number; body: unknown })[]) {
  const calls: { url: string; method: string; body: unknown; headers: Record<string, string> }[] =
    [];
  let index = 0;

  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers,
    });

    const next = operations[Math.min(index, operations.length - 1)];
    index++;
    if (next === undefined) throw new Error("the harness was given no operations");
    const resolved =
      typeof next === "string" ? { status: 200, body: fixture(next).response } : next;
    return new Response(JSON.stringify(resolved.body), {
      status: resolved.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;

  const provider = paystack({
    secretKey: TEST_KEY,
    environment: "test",
    fetch: fetchImpl,
    sleep: async () => {},
  });

  return { provider, calls };
}

describe("construction and key safety", () => {
  test("accepts a test key", () => {
    assert.doesNotThrow(() => paystack({ secretKey: TEST_KEY, environment: "test" }));
  });

  test("refuses a live key while the environment says test", () => {
    // The check that matters most: Paystack serves test and live from one host, so
    // nothing else would catch this before real money moved.
    assert.throws(
      () => paystack({ secretKey: "sk_live_EXAMPLEreal", environment: "test" }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigurationError);
        assert.match(error.message, /LIVE secret key/);
        assert.match(error.message, /same host/);
        return true;
      },
    );
  });

  test("refuses a test key while the environment says live", () => {
    assert.throws(() => paystack({ secretKey: TEST_KEY, environment: "live" }), /TEST secret key/);
  });

  test("refuses a public key, which cannot authorise server calls", () => {
    assert.throws(() => paystack({ secretKey: "pk_test_EXAMPLEpublic" }), /must be a secret key/);
  });

  test("refuses a missing key", () => {
    assert.throws(() => paystack({ secretKey: "" }), /secretKey is required/);
  });

  test("warns loudly when a live key is used outside production", () => {
    const warnings: string[] = [];
    paystack({
      secretKey: "sk_live_EXAMPLEreal",
      environment: "live",
      onLiveKeyWarning: (message) => warnings.push(message),
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /Real money will move/);
  });

  test("never lets the key reach a log event", async () => {
    const events: unknown[] = [];
    const { provider } = (() => {
      const fetchImpl = (async () =>
        new Response(JSON.stringify(fixture("transaction-verify-success").response), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof globalThis.fetch;
      return {
        provider: paystack({
          secretKey: TEST_KEY,
          environment: "test",
          fetch: fetchImpl,
          onLog: (event) => events.push(event),
        }),
      };
    })();

    await provider.verifyTransaction("order_01HQ");
    assert.ok(!JSON.stringify(events).includes(TEST_KEY), "the secret key leaked into a log");
  });
});

describe("collections", () => {
  test("initializes a checkout, sending amount as a string as Paystack documents", async () => {
    const { provider, calls } = harness(["transaction-initialize"]);

    const checkout = await provider.createCheckout({
      amount: naira(5_000),
      email: "ada@example.com",
      reference: "order_01HQ",
      channels: ["card", "bank_transfer"],
    });

    assert.equal(checkout.checkoutUrl, "https://checkout.paystack.com/3ni8kdavz62431k");
    assert.equal(checkout.reference, "order_01HQ");

    const body = calls[0]?.body as Record<string, unknown>;
    assert.equal(body.amount, "500000", "amount must be the string form on this endpoint");
    assert.equal(body.currency, "NGN");
    assert.deepEqual(body.channels, ["card", "bank_transfer"]);
    assert.equal(calls[0]?.headers.authorization, `Bearer ${TEST_KEY}`);
  });

  test("maps our channel names onto Paystack's", async () => {
    const { provider, calls } = harness(["transaction-initialize"]);
    await provider.createCheckout({
      amount: naira(5_000),
      email: "ada@example.com",
      channels: ["bank_account", "ussd"],
    });
    // Ours is `bank_account`; Paystack calls the same thing `bank`.
    const call = calls[0];
    assert.ok(call, "the adapter should have made a request");
    assert.deepEqual((call.body as Record<string, unknown>).channels, ["bank", "ussd"]);
  });

  test("refuses a channel Paystack does not offer, before any request", async () => {
    const { provider, calls } = harness(["transaction-initialize"]);
    await assert.rejects(
      provider.createCheckout({
        amount: naira(5_000),
        email: "ada@example.com",
        channels: ["google_pay"],
      }),
      (error: unknown) => {
        assert.ok(error instanceof ValidationError);
        assert.match(error.message, /google_pay/);
        return true;
      },
    );
    assert.equal(calls.length, 0, "it must fail locally, not at the provider");
  });

  test("normalises a successful verification, keeping requested and paid amounts apart", async () => {
    const { provider } = harness(["transaction-verify-success"]);
    const txn = await provider.verifyTransaction("order_01HQ");

    assert.equal(txn.status, "successful");
    assert.equal(txn.reference, "order_01HQ");
    assert.equal(txn.providerReference, "4099260516");
    // Paystack returns both; conflating them would hide partial and over payments.
    assert.equal(txn.amount?.amount, 30_050, "requested_amount");
    assert.equal(txn.amountPaid?.amount, 40_333, "amount actually paid");
    assert.equal(txn.fees?.amount, 10_283);
    assert.equal(txn.channel, "card");
    assert.equal(txn.customer?.email, "ada@example.com");
    assert.equal(txn.customer?.name, "Ada Obi");
    assert.equal(txn.authorization?.code, "AUTH_uh8bcl3zbn");
    assert.equal(txn.authorization?.reusable, true);
    assert.ok(txn.paidAt instanceof Date);
    assert.ok(txn.raw, "the provider payload is always kept");
  });

  test("collapses Paystack's in-flight statuses to pending, which is the safe direction", async () => {
    const { provider } = harness(["transaction-verify-pending"]);
    const txn = await provider.verifyTransaction("order_pending");
    // "ongoing" means not finished. Mapping it to anything but pending could cause an
    // application to give value early.
    assert.equal(txn.status, "pending");
  });

  test("creates a refund and treats it as money-moving", async () => {
    const { provider, calls } = harness(["refund-create"]);
    const refund = await provider.createRefund({ transaction: "order_01HQ" });

    assert.equal(refund.status, "pending");
    assert.equal(refund.transactionReference, "order_01HQ");
    assert.equal(refund.amount?.amount, 500_000);
    assert.equal(calls.length, 1);
  });

  test("a refund is never retried, even on a 503", async () => {
    const { provider, calls } = harness([{ status: 503, body: {} }]);
    await assert.rejects(
      provider.createRefund({ transaction: "order_01HQ" }),
      PayoutStatusUnknownError,
    );
    assert.equal(calls.length, 1, "refunding twice is worse than failing");
  });
});

describe("virtual accounts", () => {
  test("requires a BVN locally, before any request", async () => {
    const { provider, calls } = harness(["dedicated-account-assign"]);
    await assert.rejects(
      provider.createStaticVirtualAccount({
        email: "ada@example.com",
        firstName: "Ada",
        lastName: "Obi",
        phone: "+2348100000000",
        preferredBank: "wema-bank",
      }),
      (error: unknown) => {
        assert.ok(error instanceof KycRequiredError);
        assert.deepEqual(error.required, ["bvn"]);
        assert.match(error.message, /CBN rules/);
        return true;
      },
    );
    assert.equal(calls.length, 0);
  });

  test("assigns an account and reports it as pending, not as an account number", async () => {
    const { provider, calls } = harness(["dedicated-account-assign"]);
    const result = await provider.createStaticVirtualAccount({
      email: "ada@example.com",
      firstName: "Ada",
      lastName: "Obi",
      phone: "+2348100000000",
      preferredBank: "wema-bank",
      bvn: "22222222222",
    });

    // Paystack only acknowledges; the account arrives by webhook. Inventing an account
    // number here would be a lie the caller could act on.
    assert.equal(result.status, "pending");
    assert.match(result.message, /in progress/);
    const assignCall = calls[0];
    assert.ok(assignCall, "the adapter should have made a request");
    assert.equal((assignCall.body as Record<string, unknown>).bvn, "22222222222");
  });

  test("normalises a fetched account, enriching the bank from naija-data", async () => {
    const { provider } = harness(["dedicated-account-get"]);
    const account = await provider.getVirtualAccount("253");

    assert.equal(account.accounts[0]?.accountNumber, "9930000737");
    assert.equal(account.accounts[0]?.bankSlug, "wema-bank");
    assert.equal(account.accounts[0]?.institution?.id, "wema-bank");
    assert.equal(account.status, "active");
    // Identification is asynchronous on Paystack, so a fresh account is pending.
    assert.equal(account.kycStatus, "pending");
  });
});

describe("splits and subaccounts", () => {
  test("creates a subaccount, sending both field names the docs disagree about", async () => {
    const { provider, calls } = harness(["subaccount-create"]);
    const account = await provider.createSplitAccount({
      businessName: "Ada Fabrics",
      bankCode: "044",
      accountNumber: "0123456789",
      percentageCharge: 2.5,
    });

    assert.equal(account.code, "ACCT_6uujpqtzmnufzkw");
    assert.equal(account.verified, false, "Paystack verifies settlement details later");
    assert.equal(account.settlementAccount?.institution?.id, "access-bank");

    const body = calls[0]?.body as Record<string, unknown>;
    // The reference says bank_code, the cURL sample sends settlement_bank. Sending both
    // costs nothing and tolerates either.
    assert.equal(body.bank_code, "044");
    assert.equal(body.settlement_bank, "044");
  });

  test("converts basis points to the percentage Paystack wants", async () => {
    const { provider, calls } = harness(["split-create"]);
    const split = await provider.createSplit({
      name: "marketplace",
      type: "percentage",
      currency: "NGN",
      parties: [{ account: "ACCT_6uujpqtzmnufzkw", share: 9_000 }],
    });

    assert.equal(split.code, "SPL_RcScyW5jp2");
    const body = calls[0]?.body as { subaccounts: { share: number }[] };
    assert.equal(body.subaccounts[0]?.share, 90, "9000 basis points is 90%");
  });

  test("refuses a fractional share and shares over 100%", async () => {
    const { provider } = harness(["split-create"]);
    await assert.rejects(
      provider.createSplit({
        name: "x",
        type: "percentage",
        currency: "NGN",
        parties: [{ account: "ACCT_1", share: 12.5 }],
      }),
      /non-negative integer/,
    );
    await assert.rejects(
      provider.createSplit({
        name: "x",
        type: "percentage",
        currency: "NGN",
        parties: [
          { account: "ACCT_1", share: 6_000 },
          { account: "ACCT_2", share: 5_000 },
        ],
      }),
      /more than 100%/,
    );
  });
});

describe("payouts", () => {
  test("validates Paystack's strict reference format locally", async () => {
    const { provider, calls } = harness(["transferrecipient-create", "transfer-create"]);

    // Too short (Paystack requires at least 16 characters), and uppercase is not allowed.
    for (const reference of ["short", "Payout_With_Capitals_01", "has spaces in it ok"]) {
      await assert.rejects(
        provider.createPayout({
          amount: naira(25_000),
          accountNumber: "0123456789",
          bankCode: "044",
          accountName: "ADA OBI",
          reference,
        }),
        (error: unknown) => {
          assert.ok(error instanceof ValidationError);
          assert.match(error.message, /16 to 50 characters/);
          return true;
        },
        reference,
      );
    }
    assert.equal(calls.length, 0, "a malformed reference must never reach the provider");
  });

  test("creates the recipient then the transfer", async () => {
    const { provider, calls } = harness(["transferrecipient-create", "transfer-create"]);
    const payout = await provider.createPayout({
      amount: naira(25_000),
      accountNumber: "0123456789",
      bankCode: "044",
      accountName: "ADA OBI",
      reference: "payout-01hq-abcdefgh",
      reason: "Vendor settlement",
    });

    assert.equal(calls.length, 2);
    assert.match(calls[0]?.url ?? "", /\/transferrecipient$/);
    assert.match(calls[1]?.url ?? "", /\/transfer$/);

    const transferBody = calls[1]?.body as Record<string, unknown>;
    assert.equal(transferBody.recipient, "RCP_m7ljkv8leesep7p");
    assert.equal(transferBody.amount, 2_500_000, "kobo, as an integer on this endpoint");
    assert.equal(transferBody.source, "balance");

    assert.equal(payout.status, "successful");
    assert.equal(payout.providerReference, "TRF_v5tip3zx8nna9o78");
    assert.equal(payout.awaitingOtp, false);
  });

  test("reports an OTP-gated transfer as pending, never as successful", async () => {
    // The trap: Paystack returns HTTP 200 with status "otp" when OTP is enabled, and the
    // transfer has NOT happened until a human enters the code.
    const { provider } = harness(["transferrecipient-create", "transfer-create-otp"]);
    const payout = await provider.createPayout({
      amount: naira(25_000),
      accountNumber: "0123456789",
      bankCode: "044",
      accountName: "ADA OBI",
      reference: "payout-01hq-otpcase1",
    });

    assert.equal(payout.status, "pending");
    assert.equal(payout.awaitingOtp, true, "the caller must be told a human is needed");
  });

  test("a transfer is never retried; a 503 becomes PayoutStatusUnknownError", async () => {
    const { provider, calls } = harness([
      "transferrecipient-create",
      { status: 503, body: {} },
      { status: 200, body: fixture("transfer-create").response },
    ]);

    await assert.rejects(
      provider.createPayout({
        amount: naira(25_000),
        accountNumber: "0123456789",
        bankCode: "044",
        accountName: "ADA OBI",
        reference: "payout-01hq-abcdefgh",
      }),
      (error: unknown) => {
        assert.ok(error instanceof PayoutStatusUnknownError);
        assert.equal(error.reference, "payout-01hq-abcdefgh");
        assert.equal(error.retryable, false);
        return true;
      },
    );

    assert.equal(calls.length, 2, "recipient once, transfer once — never twice");
  });

  test("resolves an account and enriches it without substituting the code", async () => {
    const { provider } = harness(["bank-resolve"]);
    const account = await provider.resolveAccount({
      accountNumber: "0123456789",
      bankCode: "044",
    });

    assert.equal(account.accountName, "ADA OBI");
    // Paystack's own code is preserved verbatim; naija-data only enriches.
    assert.equal(account.bankCode, "044");
    assert.equal(account.institution?.id, "access-bank");
    assert.equal(account.institution?.matchedBy, "cbn_code");
    assert.equal(account.mergerWarning, null);
  });
});

describe("errors", () => {
  test("treats status:false on a 200 as a failure", async () => {
    // Paystack normally uses correct HTTP statuses, but this envelope is possible and
    // reading it as success would be the worst kind of bug.
    const { provider } = harness([
      { status: 200, body: fixture("error-duplicate-reference").response },
    ]);
    await assert.rejects(
      provider.createCheckout({ amount: naira(5_000), email: "ada@example.com" }),
      /Duplicate Transaction Reference/,
    );
  });

  test("classifies a duplicate reference from the message", async () => {
    const { provider } = harness([
      { status: 400, body: { status: false, message: "Duplicate Transaction Reference" } },
    ]);
    await assert.rejects(provider.verifyTransaction("order_01HQ"), DuplicateReferenceError);
  });

  test("classifies a BVN failure as KycRequiredError", async () => {
    const { provider } = harness([
      { status: 400, body: { status: false, message: "Customer BVN is invalid" } },
    ]);
    await assert.rejects(provider.verifyTransaction("order_01HQ"), KycRequiredError);
  });
});

describe("capabilities", () => {
  test("declares what it implements", () => {
    const provider = paystack({ secretKey: TEST_KEY, environment: "test" });
    assert.ok(supports(provider.capabilities, "checkout.create"));
    assert.ok(supports(provider.capabilities, "virtualAccounts.createStatic"));
    assert.ok(supports(provider.capabilities, "splits.create"));
    assert.ok(supports(provider.capabilities, "payouts.create"));
  });

  test("refuses wallets outright, because Paystack has no such product", () => {
    // Pretending otherwise would be the worst thing this SDK could do.
    const provider = paystack({ secretKey: TEST_KEY, environment: "test" });
    assert.equal(supports(provider.capabilities, "wallets.open"), false);
    assert.throws(
      () => assertSupported(provider.capabilities, "wallets.open"),
      (error: unknown) => {
        assert.ok(error instanceof UnsupportedOperationError);
        assert.match(error.message, /paystack does not support wallets\.open/);
        return true;
      },
    );
  });

  test("declares the full-body webhook signature it actually uses", () => {
    const provider = paystack({ secretKey: TEST_KEY, environment: "test" });
    assert.equal(provider.capabilities.webhookSignature?.strength, "full-body");
    assert.equal(provider.capabilities.webhookSignature?.header, "x-paystack-signature");
  });
});

describe("webhooks", () => {
  test("verifies a webhook signed with the secret key", async () => {
    const provider = paystack({ secretKey: TEST_KEY, environment: "test" });
    const body = new TextEncoder().encode(
      '{"event":"charge.success","data":{"reference":"order_01HQ"}}',
    );
    const signature = await computeSignature(SCHEMES.paystack, body, TEST_KEY);

    const result = await provider.verifyWebhook({
      body,
      headers: { "x-paystack-signature": signature },
    });
    assert.ok(result.verified);
    assert.equal(result.strength, "full-body");
  });

  test("rejects a tampered body", async () => {
    const provider = paystack({ secretKey: TEST_KEY, environment: "test" });
    const body = new TextEncoder().encode('{"event":"charge.success","data":{"amount":100}}');
    const signature = await computeSignature(SCHEMES.paystack, body, TEST_KEY);

    const result = await provider.verifyWebhook({
      body: new TextEncoder().encode('{"event":"charge.success","data":{"amount":9999999}}'),
      headers: { "x-paystack-signature": signature },
    });
    assert.equal(result.verified, false);
  });

  test("knows Paystack's documented webhook IPs, as a second check not a replacement", () => {
    const provider = paystack({ secretKey: TEST_KEY, environment: "test" });
    assert.ok(provider.isKnownWebhookIp("52.31.139.75"));
    assert.ok(provider.isKnownWebhookIp("52.214.14.220"));
    assert.ok(!provider.isKnownWebhookIp("1.2.3.4"));
  });
});

describe("money handling", () => {
  test("sends integer minor units on the transfer endpoint", async () => {
    const { provider, calls } = harness(["transferrecipient-create", "transfer-create"]);
    await provider.createPayout({
      amount: money(123_456, "NGN"),
      accountNumber: "0123456789",
      bankCode: "044",
      accountName: "ADA OBI",
      reference: "payout-01hq-abcdefgh",
    });
    const body = calls[1]?.body as Record<string, unknown>;
    assert.equal(body.amount, 123_456);
    assert.ok(Number.isInteger(body.amount), "never a float");
  });

  test("the adapter class is exported for type-level use", () => {
    assert.equal(typeof PaystackProvider, "function");
  });
});
