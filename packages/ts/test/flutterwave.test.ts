import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { operationsNotSandboxVerified, supports } from "../src/core/capabilities.ts";
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
import { FlutterwaveProvider, flutterwave } from "../src/providers/flutterwave/index.ts";

const FIXTURES = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")),
  "..",
  "..",
  "..",
  "fixtures",
  "providers",
  "flutterwave",
);

/** Loads a recorded response, so no test invents a provider payload. */
function fixture(operation: string): { request: unknown; response: unknown } {
  return {
    request: JSON.parse(readFileSync(path.join(FIXTURES, operation, "request.json"), "utf8")),
    response: JSON.parse(readFileSync(path.join(FIXTURES, operation, "response.json"), "utf8")),
  };
}

const TEST_KEY = "FLWSECK_TEST-EXAMPLEflutterwave-X";
const WEBHOOK_HASH = "EXAMPLE-secret-hash";

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

  const provider = flutterwave({
    secretKey: TEST_KEY,
    webhookSecretHash: WEBHOOK_HASH,
    environment: "test",
    fetch: fetchImpl,
    sleep: async () => {},
  });

  return { provider, calls };
}

/**
 * The JSON body of the nth recorded request.
 *
 * Asserts the request happened rather than casting a possibly-undefined value, so a
 * test that makes no call fails with that message instead of a TypeError.
 */
function bodyOf<T>(calls: { body: unknown }[], index: number): T {
  const call = calls[index];
  assert.ok(call, `expected at least ${index + 1} request(s), got ${calls.length}`);
  return call.body as T;
}

describe("construction and key safety", () => {
  test("accepts a test key", () => {
    assert.doesNotThrow(() => flutterwave({ secretKey: TEST_KEY, environment: "test" }));
  });

  test("refuses a live key while the environment says test", () => {
    // The check that matters most: v3 serves test and live from one host, so nothing
    // else would catch this before real money moved.
    assert.throws(
      () => flutterwave({ secretKey: "FLWSECK-EXAMPLEreal-X", environment: "test" }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigurationError);
        assert.match(error.message, /LIVE secret key/);
        assert.match(error.message, /same host/);
        return true;
      },
    );
  });

  test("refuses a test key while the environment says live", () => {
    assert.throws(
      () => flutterwave({ secretKey: TEST_KEY, environment: "live" }),
      ConfigurationError,
    );
  });

  test("refuses a public key", () => {
    assert.throws(
      () => flutterwave({ secretKey: "FLWPUBK_TEST-EXAMPLEpublic-X", environment: "test" }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigurationError);
        assert.match(error.message, /FLWPUBK/);
        return true;
      },
    );
  });

  test("refuses a v4 OAuth client secret, naming the version it speaks", () => {
    // Someone holding v4 credentials should be told why they do not work here, not
    // left with an authentication failure from the provider.
    assert.throws(
      () => flutterwave({ secretKey: "EXAMPLE-v4-client-secret", environment: "test" }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigurationError);
        assert.match(error.message, /v4 OAuth client secret is not a v3 key/);
        return true;
      },
    );
  });

  test("refuses an empty key", () => {
    assert.throws(() => flutterwave({ secretKey: "  " }), ConfigurationError);
  });
});

describe("amounts are decimal on the wire and integer minor units in the API", () => {
  test("a checkout sends major units, not kobo", async () => {
    const { provider, calls } = harness(["payment-initialize"]);
    await provider.createCheckout({
      amount: naira(5000),
      email: "ada@example.com",
      reference: "order-01HQ-EXAMPLE",
    });

    // The whole point: 5,000 naira is 500000 kobo internally and 5000 on the wire.
    // Sending the kobo figure would charge a hundred times too much.
    assert.equal(bodyOf<{ amount: number }>(calls, 0).amount, 5000);
    assert.notEqual(bodyOf<{ amount: number }>(calls, 0).amount, 500_000);
  });

  test("a fractional amount survives the round trip exactly", async () => {
    const { provider, calls } = harness(["payment-initialize"]);
    // 20,000.50 naira. A naive conversion is where the stray kobo disappears.
    await provider.createCheckout({
      amount: money(2_000_050, "NGN"),
      email: "ada@example.com",
      reference: "order-01HR-EXAMPLE",
    });
    assert.equal(bodyOf<{ amount: number }>(calls, 0).amount, 20_000.5);
  });

  test("a decimal balance comes back as exact minor units", async () => {
    const { provider } = harness(["balances-get"]);
    const balances = await provider.getBalance();

    // 20000.5 is 2,000,050 kobo. 3.29 USD is 329 cents, and a plain multiply by 100
    // gives 328.99999999999994 — the case that forced the round-trip assertion.
    assert.deepEqual(balances, [
      { amount: 2_000_050, currency: "NGN" },
      { amount: 329, currency: "USD" },
    ]);
  });

  test("a verified transaction keeps amount, charged amount and settled amount apart", async () => {
    const { provider } = harness(["transaction-verify-success"]);
    const transaction = await provider.verifyTransaction(288_200_108);

    assert.equal(transaction.status, "successful");
    assert.deepEqual(transaction.amount, money(500_000, "NGN"));
    assert.deepEqual(transaction.amountPaid, money(500_000, "NGN"));
    assert.deepEqual(transaction.fees, money(7_000, "NGN"));
    // 4930.0 settled out of 5000 charged: the fee came off.
    assert.deepEqual(transaction.amountSettled, money(493_000, "NGN"));
  });
});

describe("collections", () => {
  test("returns the hosted link", async () => {
    const { provider, calls } = harness(["payment-initialize"]);
    const checkout = await provider.createCheckout({
      amount: naira(5000),
      email: "ada@example.com",
      reference: "order-01HQ-EXAMPLE",
      channels: ["card", "bank_transfer"],
    });

    assert.match(checkout.checkoutUrl, /^https:\/\/checkout\.flutterwave\.com\//);
    assert.equal(checkout.reference, "order-01HQ-EXAMPLE");
    assert.equal(calls[0]?.method, "POST");
    assert.match(calls[0]?.url ?? "", /\/v3\/payments$/);
  });

  test("channels go as a comma-separated string, not an array", async () => {
    const { provider, calls } = harness(["payment-initialize"]);
    await provider.createCheckout({
      amount: naira(5000),
      email: "ada@example.com",
      reference: "order-01HQ-EXAMPLE",
      channels: ["card", "bank_transfer", "ussd"],
    });

    // Flutterwave ignores an array here, which silently offers every channel instead
    // of the ones that were asked for.
    const body = bodyOf<{ payment_options: unknown }>(calls, 0);
    assert.equal(body.payment_options, "card,banktransfer,ussd");
  });

  test("refuses a channel Flutterwave does not support", async () => {
    const { provider } = harness(["payment-initialize"]);
    await assert.rejects(
      provider.createCheckout({
        amount: naira(5000),
        email: "ada@example.com",
        reference: "order-01HQ-EXAMPLE",
        channels: ["google_pay"],
      }),
      (error: unknown) => {
        assert.ok(error instanceof ValidationError);
        assert.match(error.message, /google_pay/);
        return true;
      },
    );
  });

  test("refuses a reference v4 would reject", async () => {
    const { provider } = harness(["payment-initialize"]);
    await assert.rejects(
      provider.createCheckout({
        amount: naira(5000),
        email: "ada@example.com",
        // Underscores are fine in v3 and rejected by v4's pattern.
        reference: "order_01HQ",
      }),
      (error: unknown) => {
        assert.ok(error instanceof ValidationError);
        assert.match(error.message, /letters, digits and hyphens/);
        return true;
      },
    );
  });

  test("a pending transaction is never reported as paid", async () => {
    const { provider } = harness(["transaction-verify-pending"]);
    const transaction = await provider.verifyTransaction(288_200_109);
    assert.equal(transaction.status, "pending");
    assert.equal(transaction.paidAt, null);
  });

  test("verifying by reference uses the by-reference route", async () => {
    const { provider, calls } = harness(["transaction-verify-success"]);
    await provider.verifyTransactionByReference("order-01HQ-EXAMPLE");
    assert.match(calls[0]?.url ?? "", /verify_by_reference\?tx_ref=order-01HQ-EXAMPLE/);
  });

  test("a refund sends major units and normalises the status", async () => {
    const { provider, calls } = harness(["transaction-refund"]);
    const refund = await provider.createRefund({
      transactionId: 288_200_108,
      amount: naira(2000),
    });

    assert.equal(bodyOf<{ amount: number }>(calls, 0).amount, 2000);
    assert.equal(refund.status, "processed");
    assert.deepEqual(refund.amount, money(200_000, "NGN"));
  });
});

describe("payouts", () => {
  test("a queued transfer is pending, not successful", async () => {
    const { provider } = harness(["transfer-create"]);
    const payout = await provider.createPayout({
      amount: naira(5000),
      accountNumber: "0690000037",
      bankCode: "044",
      reference: "payout-01hq-example",
    });

    // The envelope says "status": "success" and "Transfer Queued Successfully" while
    // data.status says "NEW". Reading the envelope marks every payout as paid the
    // instant Flutterwave accepts it.
    assert.equal(payout.status, "pending");
    assert.equal(payout.awaitingApproval, false);
    assert.equal(payout.awaitingOtp, false);
    assert.deepEqual(payout.amount, money(500_000, "NGN"));
    assert.deepEqual(payout.fee, money(4_500, "NGN"));
  });

  test("the raw fixture really does say NEW, so the test above is not tautological", () => {
    const { response } = fixture("transfer-create");
    const body = response as { status: string; data: { status: string } };
    assert.equal(body.status, "success");
    assert.equal(body.data.status, "NEW");
  });

  test("a transfer awaiting dashboard approval says so", async () => {
    const { response } = fixture("transfer-create");
    const gated = structuredClone(response) as {
      data: { requires_approval: number; is_approved: number };
    };
    gated.data.requires_approval = 1;
    gated.data.is_approved = 0;

    const { provider } = harness([{ status: 200, body: gated }]);
    const payout = await provider.createPayout({
      amount: naira(5000),
      accountNumber: "0690000037",
      bankCode: "044",
      reference: "payout-01hq-example",
    });

    assert.equal(payout.awaitingApproval, true);
    assert.equal(payout.status, "pending");
  });

  test("a money-moving transfer is not retried", async () => {
    let attempts = 0;
    const fetchImpl = (async () => {
      attempts++;
      return new Response(JSON.stringify({ status: "error", message: "Service unavailable" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;

    const provider = flutterwave({
      secretKey: TEST_KEY,
      environment: "test",
      fetch: fetchImpl,
      sleep: async () => {},
    });

    await assert.rejects(
      provider.createPayout({
        amount: naira(5000),
        accountNumber: "0690000037",
        bankCode: "044",
        reference: "payout-01hq-example",
      }),
      (error: unknown) => {
        // Not ProviderDownError: a money-moving request whose outcome is unknown gets
        // its own type, because the one thing an application must not do is retry it.
        assert.ok(error instanceof PayoutStatusUnknownError);
        assert.match(error.message, /must NOT be retried/);
        return true;
      },
    );
    // Exactly one attempt: a retried payout can pay twice.
    assert.equal(attempts, 1);
  });

  test("a duplicate reference is a typed error", async () => {
    const { provider } = harness([
      { status: 400, body: fixture("error-duplicate-reference").response },
    ]);
    await assert.rejects(
      provider.createPayout({
        amount: naira(5000),
        accountNumber: "0690000037",
        bankCode: "044",
        reference: "payout-01hq-example",
      }),
      DuplicateReferenceError,
    );
  });

  test("an empty balance is a typed error, on Flutterwave's own wording", async () => {
    const { provider } = harness([
      { status: 400, body: fixture("error-insufficient-funds").response },
    ]);
    await assert.rejects(
      provider.createPayout({
        amount: naira(500_000),
        accountNumber: "0690000037",
        bankCode: "044",
        reference: "payout-01hr-example",
      }),
      InsufficientFundsError,
    );
  });

  test("status 'error' inside a 200 is still a failure", async () => {
    // v3 does this, and treating a 200 as success without reading the envelope is how
    // a duplicate payout gets reported as sent.
    const { provider } = harness([
      { status: 200, body: { status: "error", message: "Transfer reference is used already" } },
    ]);
    await assert.rejects(
      provider.createPayout({
        amount: naira(5000),
        accountNumber: "0690000037",
        bankCode: "044",
        reference: "payout-01hq-example",
      }),
      DuplicateReferenceError,
    );
  });

  test("resolving an account carries the bank code through", async () => {
    const { provider } = harness(["accounts-resolve"]);
    const account = await provider.resolveAccount({
      accountNumber: "0690000032",
      bankCode: "044",
    });

    // Flutterwave's response omits the bank code, so without carrying it the enriched
    // result would have nothing to match an institution on.
    assert.equal(account.bankCode, "044");
    assert.equal(account.accountNumber, "0690000032");
    assert.equal(account.provider, "flutterwave");
  });

  test("listing banks enriches from naija-data without changing the codes", async () => {
    const { provider } = harness(["banks-list"]);
    const banks = await provider.listBanks();

    assert.equal(banks.length, 4);
    // Both 3-digit and 6-digit codes, untouched. This mixture is why single-code
    // normalisation was abandoned; see the bank-codes section of DESIGN.md.
    assert.deepEqual(
      banks.map((b) => b.code),
      ["560", "304", "044", "000019"],
    );
  });
});

describe("wallets, the capability Paystack has no answer to", () => {
  test("opening a wallet returns both identifiers it needs later", async () => {
    const { provider } = harness(["payout-subaccount-create"]);
    const wallet = await provider.openWallet({
      accountName: "Ada Example",
      email: "ada@example.com",
    });

    // account_reference debits the wallet; barter_id receives wallet-to-wallet money.
    // Losing either one strands the wallet.
    assert.equal(wallet.reference, "FLW-EXAMPLE00000000000000000000000");
    assert.equal(wallet.barterId, "FLW-EXAMPLE-BARTER");
    assert.equal(wallet.status, "active");
    assert.equal(wallet.account?.accountNumber, "8548349036");
  });

  test("a wallet balance converts the decimal exactly", async () => {
    const { provider } = harness(["payout-subaccount-balance"]);
    const balance = await provider.getWalletBalance({
      reference: "FLW-EXAMPLE00000000000000000000000",
    });

    assert.deepEqual(balance.available, money(120_009, "NGN"));
    assert.deepEqual(balance.ledger, money(120_009, "NGN"));
  });

  test("a non-NGN wallet balance fails locally", async () => {
    const { provider, calls } = harness(["payout-subaccount-balance"]);
    await assert.rejects(
      provider.getWalletBalance({ reference: "FLW-EXAMPLE", currency: "USD" }),
      (error: unknown) => {
        assert.ok(error instanceof ValidationError);
        assert.match(error.message, /NGN only/);
        return true;
      },
    );
    // Failed before the network, which is the point of declaring the limit.
    assert.equal(calls.length, 0);
  });

  test("a wallet payout debits the wallet, not the main balance", async () => {
    const { provider, calls } = harness(["transfer-from-wallet"]);
    const payout = await provider.transferFromWallet({
      walletReference: "FLW-EXAMPLE00000000000000000000000",
      amount: naira(2500),
      reference: "walletpay-01hq-example",
      accountNumber: "0690000037",
      bankCode: "044",
    });

    const body = bodyOf<{ debit_subaccount: string; amount: number }>(calls, 0);
    assert.equal(body.debit_subaccount, "FLW-EXAMPLE00000000000000000000000");
    assert.equal(body.amount, 2500);
    assert.equal(payout.status, "pending");
  });

  test("a wallet-to-wallet transfer uses the flutterwave sentinel bank", async () => {
    const { provider, calls } = harness(["transfer-from-wallet"]);
    await provider.transferFromWallet({
      walletReference: "FLW-EXAMPLE00000000000000000000000",
      amount: naira(2500),
      reference: "walletpay-01hr-example",
      toBarterId: "FLW-OTHER-BARTER",
    });

    const body = bodyOf<{ account_bank: string; account_number: string }>(calls, 0);
    assert.equal(body.account_bank, "flutterwave");
    assert.equal(body.account_number, "FLW-OTHER-BARTER");
  });

  test("a wallet transfer with no destination fails locally", async () => {
    const { provider, calls } = harness(["transfer-from-wallet"]);
    await assert.rejects(
      provider.transferFromWallet({
        walletReference: "FLW-EXAMPLE",
        amount: naira(2500),
        reference: "walletpay-01hs-example",
      }),
      (error: unknown) => {
        assert.ok(error instanceof ValidationError);
        assert.match(error.message, /exactly one destination/);
        return true;
      },
    );
    assert.equal(calls.length, 0);
  });

  test("a wallet transfer with two destinations also fails locally", async () => {
    const { provider } = harness(["transfer-from-wallet"]);
    await assert.rejects(
      provider.transferFromWallet({
        walletReference: "FLW-EXAMPLE",
        amount: naira(2500),
        reference: "walletpay-01ht-example",
        accountNumber: "0690000037",
        bankCode: "044",
        toBarterId: "FLW-OTHER-BARTER",
      }),
      ValidationError,
    );
  });
});

describe("splits", () => {
  test("basis points become Flutterwave's decimal fraction", async () => {
    const { provider, calls } = harness(["subaccount-create"]);
    const account = await provider.createSplitAccount({
      businessName: "Example Vendor",
      accountNumber: "0690000037",
      bankCode: "044",
      businessMobile: "07000000000",
      shareBasisPoints: 900,
    });

    // 900 bps is 9%, and Flutterwave's own documentation says a 9% commission is 0.09.
    const body = bodyOf<{ split_type: string; split_value: number }>(calls, 0);
    assert.equal(body.split_type, "percentage");
    assert.equal(body.split_value, 0.09);
    // And back again, so the round trip holds.
    assert.equal(account.percentageCharge, 900);
    assert.equal(account.code, "RS_EXAMPLE4D9C66C0B1C75014EE67D4D66");
  });

  test("a flat default share sends major units", async () => {
    const { provider, calls } = harness(["subaccount-create"]);
    await provider.createSplitAccount({
      businessName: "Example Vendor",
      accountNumber: "0690000037",
      bankCode: "044",
      businessMobile: "07000000000",
      flatShare: naira(600),
    });

    const body = bodyOf<{ split_type: string; split_value: number }>(calls, 0);
    assert.equal(body.split_type, "flat");
    assert.equal(body.split_value, 600);
  });

  test("a subaccount must have exactly one kind of default share", async () => {
    const { provider, calls } = harness(["subaccount-create"]);
    const base = {
      businessName: "Example Vendor",
      accountNumber: "0690000037",
      bankCode: "044",
      businessMobile: "07000000000",
    };

    await assert.rejects(provider.createSplitAccount(base), (error: unknown) => {
      assert.ok(error instanceof ValidationError);
      assert.match(error.message, /exactly one of/);
      return true;
    });
    await assert.rejects(
      provider.createSplitAccount({ ...base, shareBasisPoints: 900, flatShare: naira(600) }),
      ValidationError,
    );
    assert.equal(calls.length, 0);
  });

  test("createSplit builds a declaration and makes no network call", () => {
    const { provider, calls } = harness([]);
    const split = provider.createSplit([
      { subaccountId: "RS_A", commissionBasisPoints: 2000 },
      { subaccountId: "RS_B", subaccountReceives: naira(4200) },
      { subaccountId: "RS_C", commissionFlat: naira(100), ratio: 2 },
    ]);

    assert.equal(calls.length, 0);
    assert.deepEqual(split, [
      { id: "RS_A", transaction_charge_type: "percentage", transaction_charge: 0.2 },
      { id: "RS_B", transaction_charge_type: "flat_subaccount", transaction_charge: 4200 },
      {
        id: "RS_C",
        transaction_split_ratio: 2,
        transaction_charge_type: "flat",
        transaction_charge: 100,
      },
    ]);
  });

  test("a split party cannot name two charge types", () => {
    const { provider } = harness([]);
    assert.throws(
      () =>
        provider.createSplit([
          { subaccountId: "RS_A", commissionBasisPoints: 2000, commissionFlat: naira(100) },
        ]),
      (error: unknown) => {
        assert.ok(error instanceof ValidationError);
        assert.match(error.message, /more than one of/);
        return true;
      },
    );
  });

  test("a split declaration reaches the checkout body", async () => {
    const { provider, calls } = harness(["payment-initialize"]);
    await provider.createCheckout({
      amount: naira(5000),
      email: "ada@example.com",
      reference: "order-01HQ-EXAMPLE",
      subaccounts: provider.createSplit([{ subaccountId: "RS_A", commissionBasisPoints: 2000 }]),
    });

    const body = bodyOf<{ subaccounts: unknown[] }>(calls, 0);
    assert.deepEqual(body.subaccounts, [
      { id: "RS_A", transaction_charge_type: "percentage", transaction_charge: 0.2 },
    ]);
  });
});

describe("virtual accounts", () => {
  test("a static account needs a BVN or a NIN, and says so locally", async () => {
    const { provider, calls } = harness(["virtual-account-create"]);
    await assert.rejects(
      provider.createStaticVirtualAccount({
        email: "ada@example.com",
        reference: "va-01HQ-EXAMPLE",
      }),
      (error: unknown) => {
        assert.ok(error instanceof KycRequiredError);
        assert.match(error.message, /BVN or a NIN/);
        return true;
      },
    );
    assert.equal(calls.length, 0);
  });

  test("a NIN is accepted in place of a BVN", async () => {
    const { provider, calls } = harness(["virtual-account-create"]);
    await provider.createStaticVirtualAccount({
      email: "ada@example.com",
      reference: "va-01HQ-EXAMPLE",
      nin: "11111111111",
    });
    const body = bodyOf<{ nin: string; is_permanent: boolean }>(calls, 0);
    assert.equal(body.nin, "11111111111");
    assert.equal(body.is_permanent, true);
  });

  test("an acknowledged account is reported as pending KYC, not verified", async () => {
    const { provider } = harness(["virtual-account-create"]);
    const account = await provider.createStaticVirtualAccount({
      email: "ada@example.com",
      reference: "va-01HQ-EXAMPLE",
      bvn: "22222222222",
    });

    // response_code "02" is "Transaction in progress": the number is usable but KYC
    // may still be running, so claiming "verified" would be a lie.
    assert.equal(account.kycStatus, "pending");
    assert.equal(account.kind, "static");
    assert.equal(account.accounts[0]?.accountNumber, "7824822527");
  });

  test('Flutterwave\'s "N/A" strings do not become amounts or dates', async () => {
    const { provider } = harness(["virtual-account-create"]);
    const account = await provider.createStaticVirtualAccount({
      email: "ada@example.com",
      reference: "va-01HQ-EXAMPLE",
      bvn: "22222222222",
    });

    // The fixture has "expiry_date": "N/A" and "amount": "N/A". Parsing those gives
    // an Invalid Date and a NaN amount, neither of which should ever escape.
    assert.equal(account.expiresAt, null);
  });

  test("a dynamic account sends the amount and keeps Flutterwave's own expiry default", async () => {
    const { provider, calls } = harness(["virtual-account-create"]);
    await provider.createDynamicVirtualAccount({
      email: "ada@example.com",
      reference: "va-01HR-EXAMPLE",
      amount: naira(5000),
    });

    const body = bodyOf<{ amount: number; is_permanent: boolean; expires?: string }>(calls, 0);
    assert.equal(body.amount, 5000);
    assert.equal(body.is_permanent, false);
    // Not sent, so Flutterwave's own 60-second default applies. Choosing a longer one
    // here would widen the window in which a stale account still takes money.
    assert.equal(body.expires, undefined);
  });
});

describe("webhooks", () => {
  const BODY = new TextEncoder().encode(
    JSON.stringify({ event: "charge.completed", data: { id: 288_200_108, status: "successful" } }),
  );

  test("a v4 signature verifies as full-body", async () => {
    const { provider } = harness([]);
    const signature = await computeSignature(SCHEMES.flutterwaveV4, BODY, WEBHOOK_HASH);
    const result = await provider.verifyWebhook({
      body: BODY,
      headers: { "flutterwave-signature": signature },
    });

    assert.equal(result.verified, true);
    assert.equal(result.strength, "full-body");
    assert.equal(result.apiVersion, "v4");
  });

  test("a v3 verif-hash verifies, but only as a shared secret", async () => {
    const { provider } = harness([]);
    const result = await provider.verifyWebhook({
      body: BODY,
      headers: { "verif-hash": WEBHOOK_HASH },
    });

    // It matched, and it still proves nothing about the payload. An application that
    // requires full-body integrity can refuse this, which is why the strength is
    // reported rather than just a boolean.
    assert.equal(result.verified, true);
    assert.equal(result.strength, "shared-secret");
    assert.equal(result.apiVersion, "v3");
  });

  test("a v3 webhook's signature is identical whatever the body says", async () => {
    // Stated as a test because it is the security property that matters: the same
    // header authenticates any payload, so v3 has no integrity and no replay
    // protection. This is the behaviour signatureStrength exists to expose.
    const { provider } = harness([]);
    const tampered = new TextEncoder().encode(
      JSON.stringify({ event: "charge.completed", data: { id: 1, status: "successful" } }),
    );

    const original = await provider.verifyWebhook({
      body: BODY,
      headers: { "verif-hash": WEBHOOK_HASH },
    });
    const forged = await provider.verifyWebhook({
      body: tampered,
      headers: { "verif-hash": WEBHOOK_HASH },
    });

    assert.equal(original.verified, true);
    assert.equal(forged.verified, true);
    assert.equal(forged.strength, "shared-secret");
  });

  test("a tampered v4 body does not verify", async () => {
    const { provider } = harness([]);
    const signature = await computeSignature(SCHEMES.flutterwaveV4, BODY, WEBHOOK_HASH);
    const tampered = new TextEncoder().encode(
      JSON.stringify({ event: "charge.completed", data: { id: 1, status: "successful" } }),
    );

    const result = await provider.verifyWebhook({
      body: tampered,
      headers: { "flutterwave-signature": signature },
    });
    assert.equal(result.verified, false);
    assert.equal(result.strength, "full-body");
  });

  test("v4 is preferred when both headers arrive", async () => {
    const { provider } = harness([]);
    const signature = await computeSignature(SCHEMES.flutterwaveV4, BODY, WEBHOOK_HASH);
    const result = await provider.verifyWebhook({
      body: BODY,
      headers: { "flutterwave-signature": signature, "verif-hash": WEBHOOK_HASH },
    });

    // Verify the one that actually proves something.
    assert.equal(result.apiVersion, "v4");
    assert.equal(result.strength, "full-body");
  });

  test("no signature header at all is unverified, not verified", async () => {
    const { provider } = harness([]);
    const result = await provider.verifyWebhook({ body: BODY, headers: {} });
    assert.equal(result.verified, false);
    assert.equal(result.strength, "unverified");
    assert.equal(result.apiVersion, "unknown");
  });

  test("headers are matched case-insensitively", async () => {
    const { provider } = harness([]);
    const result = await provider.verifyWebhook({
      body: BODY,
      headers: { "Verif-Hash": WEBHOOK_HASH },
    });
    assert.equal(result.verified, true);
  });

  test("verifying without the secret hash explains which secret is needed", async () => {
    const provider = flutterwave({ secretKey: TEST_KEY, environment: "test" });
    await assert.rejects(
      provider.verifyWebhook({ body: BODY, headers: { "verif-hash": WEBHOOK_HASH } }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigurationError);
        assert.match(error.message, /not the API secret key/);
        return true;
      },
    );
  });
});

describe("endpoint paths that were verified wrong once", () => {
  /**
   * Four of these were written from Flutterwave's documentation index and were all
   * wrong. Reading each reference page caught them before release. They are pinned
   * here because the failure mode is a 404 at runtime, in a payout or a KYC update,
   * which no amount of normalising protects anybody from.
   */

  test("refunds are listed from /refunds, not /transactions/refunds", async () => {
    const { provider, calls } = harness([{ status: 200, body: { status: "success", data: [] } }]);
    await provider.listRefunds(288_200_108);
    assert.match(calls[0]?.url ?? "", /\/v3\/refunds\?id=288200108$/);
    assert.doesNotMatch(calls[0]?.url ?? "", /transactions\/refunds/);
  });

  test("the BVN update puts the order reference in the path, not the body", async () => {
    const { provider, calls } = harness([{ status: 200, body: { status: "success", data: {} } }]);
    await provider.updateVirtualAccountBvn({
      orderReference: "URF_EXAMPLE_1762000000000",
      bvn: "22222222222",
    });

    assert.equal(calls[0]?.method, "PUT");
    assert.match(calls[0]?.url ?? "", /\/virtual-account-numbers\/URF_EXAMPLE_1762000000000$/);
    // There is no /update-bvn route, and order_ref is not a body field.
    assert.doesNotMatch(calls[0]?.url ?? "", /update-bvn/);
    assert.deepEqual(bodyOf(calls, 0), { bvn: "22222222222" });
  });

  test("deactivating a virtual account POSTs a status, and reactivating is the same route", async () => {
    const { provider, calls } = harness([{ status: 200, body: { status: "success", data: {} } }]);
    await provider.deactivateVirtualAccount("URF_EXAMPLE_1762000000000");
    await provider.reactivateVirtualAccount("URF_EXAMPLE_1762000000000");

    // A POST, not a PUT, and one endpoint for both directions.
    assert.equal(calls[0]?.method, "POST");
    assert.match(calls[0]?.url ?? "", /\/virtual-account-numbers\/URF_EXAMPLE_1762000000000$/);
    assert.deepEqual(bodyOf(calls, 0), { status: "inactive" });
    assert.equal(calls[1]?.url, calls[0]?.url);
    assert.deepEqual(bodyOf(calls, 1), { status: "active" });
  });

  test("a wallet statement puts the reference in the path and requires the dates", async () => {
    const { provider, calls } = harness([{ status: 200, body: { status: "success", data: [] } }]);
    await provider.getWalletStatement({
      reference: "FLW-EXAMPLE00000000000000000000000",
      from: "2026-11-01",
      to: "2026-11-10",
    });

    assert.match(
      calls[0]?.url ?? "",
      /\/payout-subaccounts\/FLW-EXAMPLE00000000000000000000000\/transactions\?/,
    );
    // Not a query parameter, which is how it was written first.
    assert.doesNotMatch(calls[0]?.url ?? "", /account_reference=/);
    assert.match(calls[0]?.url ?? "", /from=2026-11-01/);
    assert.match(calls[0]?.url ?? "", /to=2026-11-10/);
  });

  test("a wallet statement with a blank date range fails locally", async () => {
    const { provider, calls } = harness([{ status: 200, body: { status: "success", data: [] } }]);
    await assert.rejects(
      provider.getWalletStatement({ reference: "FLW-EXAMPLE", from: "", to: "2026-11-10" }),
      (error: unknown) => {
        assert.ok(error instanceof ValidationError);
        assert.match(error.message, /both from and to dates/);
        return true;
      },
    );
    assert.equal(calls.length, 0);
  });

  test("a refund carries comments and the callback url Flutterwave spells oddly", async () => {
    const { provider, calls } = harness(["transaction-refund"]);
    await provider.createRefund({
      transactionId: 288_200_108,
      amount: naira(2000),
      comments: "duplicate order",
      callbackUrl: "https://example.com/refunds",
    });

    assert.deepEqual(bodyOf(calls, 0), {
      amount: 2000,
      comments: "duplicate order",
      // No separator, which is Flutterwave's own spelling.
      callbackurl: "https://example.com/refunds",
    });
  });
});

describe("capabilities", () => {
  test("an unsupported operation fails locally with no network call", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const provider = flutterwave({ secretKey: TEST_KEY, environment: "test", fetch: fetchImpl });
    // Narrow the instance's own declaration rather than faking the receiver, so the
    // real method runs on the real object and the guard is what stops it.
    Object.defineProperty(provider, "capabilities", {
      value: { provider: "flutterwave", operations: {} },
    });

    await assert.rejects(
      provider.getWalletStatement({
        reference: "FLW-EXAMPLE",
        from: "2026-11-01",
        to: "2026-11-10",
      }),
      UnsupportedOperationError,
    );
    // The guard ran before any request was made, which is the whole point of it.
    assert.equal(called, false);
    assert.ok(provider instanceof FlutterwaveProvider);
  });

  test("wallets are declared, unlike Paystack", () => {
    assert.ok(supports(flutterwaveCapabilitiesOf(), "wallets.open"));
    assert.ok(supports(flutterwaveCapabilitiesOf(), "wallets.balance"));
    assert.ok(supports(flutterwaveCapabilitiesOf(), "wallets.transfer"));
  });

  test("dynamic virtual accounts are declared, unlike Paystack", () => {
    assert.ok(supports(flutterwaveCapabilitiesOf(), "virtualAccounts.createDynamic"));
  });

  test("operations written from docs alone are flagged as not sandbox-verified", () => {
    const unverified = operationsNotSandboxVerified(flutterwaveCapabilitiesOf());
    // Nothing has been run against Flutterwave's sandbox yet, so the wallet and
    // virtual-account operations must say so rather than looking proven.
    assert.ok(unverified.includes("wallets.open"));
    assert.ok(unverified.includes("virtualAccounts.createStatic"));
  });

  test("the webhook declaration is honest about v3 being the weak one", () => {
    const signature = flutterwaveCapabilitiesOf().webhookSignature;
    assert.equal(signature?.strength, "shared-secret");
    assert.match(signature?.algorithm ?? "", /no signature at all/);
  });

  test("a 404 is a typed NotFoundError", async () => {
    const { provider } = harness([
      { status: 404, body: { status: "error", message: "No transaction was found" } },
    ]);
    await assert.rejects(provider.verifyTransaction(1), NotFoundError);
  });
});

function flutterwaveCapabilitiesOf() {
  return flutterwave({ secretKey: TEST_KEY, environment: "test" }).capabilities;
}
