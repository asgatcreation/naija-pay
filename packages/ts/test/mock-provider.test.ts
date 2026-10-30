import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_INFLOW_RULES,
  type InflowRules,
  classifyInflow,
  decideInflow,
  memoryStore,
} from "../src/core/events.ts";
import { naira } from "../src/core/money.ts";
import { verifySignature } from "../src/core/signatures.ts";
import { INFLOW_SCENARIOS, MOCK_SCHEME, mock } from "../src/providers/mock/index.ts";
import { assertSupported, requiredKycFor, supports } from "../src/core/capabilities.ts";
import { UnsupportedOperationError } from "../src/core/errors.ts";

const FIXED_NOW = () => new Date("2026-10-30T12:00:00.000Z");

describe("classifying an inflow", () => {
  test("recognises an exact payment", () => {
    const result = classifyInflow({ expectedAmount: naira(5_000), amountPaid: naira(5_000) });
    assert.equal(result.variance, "exact");
    assert.equal(result.varianceAmount?.amount, 0);
    assert.equal(result.isLate, false);
  });

  test("measures an overpayment", () => {
    const result = classifyInflow({ expectedAmount: naira(5_000), amountPaid: naira(5_500) });
    assert.equal(result.variance, "overpayment");
    assert.equal(result.varianceAmount?.amount, 50_000, "500 naira in kobo");
  });

  test("measures an underpayment as a positive difference", () => {
    const result = classifyInflow({ expectedAmount: naira(5_000), amountPaid: naira(4_900) });
    assert.equal(result.variance, "underpayment");
    assert.equal(result.varianceAmount?.amount, 10_000, "100 naira in kobo, unsigned");
  });

  test("a static account has no expected amount, which is normal rather than an anomaly", () => {
    const result = classifyInflow({ expectedAmount: null, amountPaid: naira(12_000) });
    assert.equal(result.variance, "unexpected");
    assert.equal(result.varianceAmount, null);
  });

  test("detects a payment that arrived after expiry", () => {
    const result = classifyInflow({
      expectedAmount: naira(5_000),
      amountPaid: naira(5_000),
      expiresAt: new Date("2026-10-30T10:00:00.000Z"),
      paidAt: new Date("2026-10-30T10:20:00.000Z"),
    });
    assert.equal(result.isLate, true);
    assert.equal(result.variance, "exact", "lateness and amount are independent");
  });

  test("is not late when the payment beat the expiry", () => {
    const result = classifyInflow({
      expectedAmount: naira(5_000),
      amountPaid: naira(5_000),
      expiresAt: new Date("2026-10-30T10:00:00.000Z"),
      paidAt: new Date("2026-10-30T09:59:00.000Z"),
    });
    assert.equal(result.isLate, false);
  });
});

describe("deciding what to do with an inflow", () => {
  test("credits an exact payment", () => {
    const decision = decideInflow({
      inflow: {
        expectedAmount: naira(5_000),
        amountPaid: naira(5_000),
        variance: "exact",
        isLate: false,
      },
    });
    assert.equal(decision.action, "credit");
    assert.equal(decision.action === "credit" && decision.amount.amount, 500_000);
  });

  test("a duplicate is always ignored, whatever the rules say", () => {
    // Not configurable on purpose: every Tier 1 provider retries webhooks — Paystack
    // for 72 hours — so duplicates are certain, and "give value twice" must never be
    // reachable through configuration.
    for (const rules of [
      DEFAULT_INFLOW_RULES,
      { overpayment: "credit_full", underpayment: "credit_partial", latePayment: "accept" },
    ] as InflowRules[]) {
      const decision = decideInflow({
        inflow: {
          expectedAmount: naira(5_000),
          amountPaid: naira(5_000),
          variance: "exact",
          isLate: false,
        },
        rules,
        alreadyProcessed: true,
      });
      assert.equal(decision.action, "ignore");
      assert.match(decision.reason, /already been processed/);
    }
  });

  test("applies each overpayment rule", () => {
    const inflow = {
      expectedAmount: naira(5_000),
      amountPaid: naira(5_500),
      variance: "overpayment" as const,
      isLate: false,
    };

    const full = decideInflow({ inflow, rules: { ...DEFAULT_INFLOW_RULES, overpayment: "credit_full" } });
    assert.equal(full.action, "credit");
    assert.equal(full.action === "credit" && full.amount.amount, 550_000);

    const expected = decideInflow({
      inflow,
      rules: { ...DEFAULT_INFLOW_RULES, overpayment: "credit_expected" },
    });
    assert.equal(expected.action, "credit");
    assert.equal(expected.action === "credit" && expected.amount.amount, 500_000);
    assert.match(expected.reason, /excess needs refunding/);

    assert.equal(
      decideInflow({ inflow, rules: { ...DEFAULT_INFLOW_RULES, overpayment: "reject" } }).action,
      "reject",
    );
    assert.equal(
      decideInflow({ inflow, rules: { ...DEFAULT_INFLOW_RULES, overpayment: "manual_review" } })
        .action,
      "manual_review",
    );
  });

  test("applies each underpayment rule, and reviews by default", () => {
    const inflow = {
      expectedAmount: naira(5_000),
      amountPaid: naira(4_900),
      variance: "underpayment" as const,
      isLate: false,
    };

    // The conservative default: partial credit silently changes what the customer
    // bought, so it must be opted into.
    assert.equal(decideInflow({ inflow }).action, "manual_review");

    const partial = decideInflow({
      inflow,
      rules: { ...DEFAULT_INFLOW_RULES, underpayment: "credit_partial" },
    });
    assert.equal(partial.action, "credit");
    assert.equal(partial.action === "credit" && partial.amount.amount, 490_000);

    assert.equal(
      decideInflow({ inflow, rules: { ...DEFAULT_INFLOW_RULES, underpayment: "reject" } }).action,
      "reject",
    );
  });

  test("lateness is decided before the amount, and accepting it falls through", () => {
    const inflow = {
      expectedAmount: naira(5_000),
      amountPaid: naira(5_000),
      variance: "exact" as const,
      isLate: true,
    };

    assert.equal(decideInflow({ inflow }).action, "credit", "the default accepts late payments");
    assert.equal(
      decideInflow({ inflow, rules: { ...DEFAULT_INFLOW_RULES, latePayment: "reject" } }).action,
      "reject",
    );
    assert.equal(
      decideInflow({ inflow, rules: { ...DEFAULT_INFLOW_RULES, latePayment: "manual_review" } })
        .action,
      "manual_review",
    );
  });

  test("late AND underpaid takes the stricter of the two outcomes", () => {
    const decision = decideInflow({
      inflow: {
        expectedAmount: naira(5_000),
        amountPaid: naira(4_000),
        variance: "underpayment",
        isLate: true,
      },
    });
    // Late is accepted by default, so the underpayment rule decides.
    assert.equal(decision.action, "manual_review");
  });

  test("credits a static account with no expected amount", () => {
    const decision = decideInflow({
      inflow: {
        expectedAmount: null,
        amountPaid: naira(12_000),
        variance: "unexpected",
        isLate: false,
      },
    });
    assert.equal(decision.action, "credit");
    assert.equal(decision.action === "credit" && decision.amount.amount, 1_200_000);
  });
});

describe("the idempotency store", () => {
  test("remembers what it has seen", () => {
    const store = memoryStore();
    assert.equal(store.has("evt_1"), false);
    store.mark("evt_1");
    assert.equal(store.has("evt_1"), true);
    assert.equal(store.has("evt_2"), false);
    assert.equal(store.size(), 1);
  });
});

describe("the mock provider", () => {
  test("emits webhooks that pass real signature verification", async () => {
    // The whole point: the security path is not stubbed. The same verifier that runs
    // against Paystack runs against the mock.
    const provider = mock({ now: FIXED_NOW });
    const webhook = await provider.simulateInflow({
      expectedAmount: naira(5_000),
      amountPaid: naira(5_000),
    });

    const result = await verifySignature({
      scheme: MOCK_SCHEME,
      body: webhook.body,
      headers: webhook.headers,
      secret: provider.secret,
    });

    assert.ok(result.verified, result.reason);
    assert.equal(result.strength, "full-body");
  });

  test("can emit a deliberately invalid signature, to test the failure path", async () => {
    const provider = mock({ now: FIXED_NOW });
    const webhook = await provider.simulateInflow({
      amountPaid: naira(5_000),
      invalidSignature: true,
    });

    const result = await verifySignature({
      scheme: MOCK_SCHEME,
      body: webhook.body,
      headers: webhook.headers,
      secret: provider.secret,
    });

    assert.equal(result.verified, false);
    assert.equal(webhook.event.signatureStrength, "unverified");
  });

  test("tampering with the body it produced is detected", async () => {
    const provider = mock({ now: FIXED_NOW });
    const webhook = await provider.simulateInflow({
      expectedAmount: naira(5_000),
      amountPaid: naira(5_000),
    });

    const tampered = new TextEncoder().encode(webhook.text.replace("500000", "99999999"));
    const result = await verifySignature({
      scheme: MOCK_SCHEME,
      body: tampered,
      headers: webhook.headers,
      secret: provider.secret,
    });
    assert.equal(result.verified, false);
  });

  test("covers every inflow edge case, with the variance the scenario claims", async () => {
    const provider = mock({ now: FIXED_NOW });
    for (const scenario of INFLOW_SCENARIOS) {
      const webhook = await provider.simulateInflow(scenario.options);
      const inflow = webhook.event.data as { variance: string; is_late: boolean };
      assert.equal(
        inflow.variance,
        scenario.expectedVariance,
        `${scenario.name}: expected ${scenario.expectedVariance}, got ${inflow.variance}`,
      );
      assert.equal(webhook.event.type, "virtual_account.credited");

      const verified = await verifySignature({
        scheme: MOCK_SCHEME,
        body: webhook.body,
        headers: webhook.headers,
        secret: provider.secret,
      });
      assert.ok(verified.verified, `${scenario.name}: signature did not verify`);
    }
  });

  test("marks the late scenarios as late", async () => {
    const provider = mock({ now: FIXED_NOW });
    for (const scenario of INFLOW_SCENARIOS.filter((s) => s.name.includes("late"))) {
      const webhook = await provider.simulateInflow(scenario.options);
      const inflow = webhook.event.data as { is_late: boolean };
      assert.equal(inflow.is_late, true, scenario.name);
    }
  });

  test("produces deterministic, sequential event ids", async () => {
    const provider = mock({ now: FIXED_NOW });
    const first = await provider.simulatePayment({ status: "successful" });
    const second = await provider.simulatePayment({ status: "failed" });
    assert.equal(first.event.id, "evt_mock_0001");
    assert.equal(second.event.id, "evt_mock_0002");
  });

  test("can replay the same event id, to exercise duplicate handling", async () => {
    const provider = mock({ now: FIXED_NOW });
    const original = await provider.simulatePayment({ status: "successful" });
    const replay = await provider.buildWebhook({
      type: original.event.type,
      data: original.event.data,
      eventId: original.event.id,
      occurredAt: original.event.occurredAt,
    });

    // A genuine redelivery: identical bytes and identical signature.
    assert.equal(replay.text, original.text);
    assert.deepEqual(replay.headers, original.headers);

    const store = memoryStore();
    store.mark(original.event.id);
    const decision = decideInflow({
      inflow: {
        expectedAmount: naira(5_000),
        amountPaid: naira(5_000),
        variance: "exact",
        isLate: false,
      },
      alreadyProcessed: store.has(replay.event.id),
    });
    assert.equal(decision.action, "ignore");
  });

  test("simulates payments and transfers in every terminal state", async () => {
    const provider = mock({ now: FIXED_NOW });
    for (const status of ["successful", "failed", "pending", "reversed"] as const) {
      const webhook = await provider.simulatePayment({ status });
      assert.equal(webhook.event.type, `payment.${status}`);
    }
    for (const status of ["successful", "failed", "reversed"] as const) {
      const webhook = await provider.simulateTransfer({ status });
      assert.equal(webhook.event.type, `transfer.${status}`);
    }
  });

  test("delivers to a URL through an injected sender, so no network is needed", async () => {
    const provider = mock({ now: FIXED_NOW });
    const webhook = await provider.simulatePayment({ status: "successful" });

    const calls: { url: string; init: RequestInit }[] = [];
    const send = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response("", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const result = await provider.deliver(webhook, "http://localhost:3000/webhooks", send);

    assert.equal(result.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "http://localhost:3000/webhooks");
    const headers = calls[0]?.init.headers as Record<string, string>;
    assert.ok(headers[MOCK_SCHEME.header], "the signature header must be delivered");
  });
});

describe("the mock's capabilities", () => {
  test("supports the whole normalised API, so every path can be exercised", () => {
    const provider = mock();
    assert.ok(supports(provider.capabilities, "wallets.open"));
    assert.ok(supports(provider.capabilities, "splits.create"));
    assert.ok(supports(provider.capabilities, "mandates.debit"));
    assert.doesNotThrow(() => assertSupported(provider.capabilities, "payouts.create"));
  });

  test("still refuses an operation that does not exist", () => {
    const provider = mock();
    assert.throws(
      // @ts-expect-error deliberately not an Operation
      () => assertSupported(provider.capabilities, "not.a.real.operation"),
      UnsupportedOperationError,
    );
  });

  test("mirrors the real providers in requiring a BVN for a static virtual account", () => {
    const provider = mock();
    assert.deepEqual(requiredKycFor(provider.capabilities, "virtualAccounts.createStatic"), [
      "bvn",
    ]);
  });

  test("declares a full-body signature, matching what it actually does", () => {
    const provider = mock();
    assert.equal(provider.capabilities.webhookSignature?.strength, "full-body");
    assert.equal(provider.capabilities.webhookSignature?.header, MOCK_SCHEME.header);
  });
});
