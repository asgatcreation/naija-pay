/**
 * The mock provider.
 *
 * A developer should be able to build and test an entire pay-by-transfer flow —
 * including signature verification and the awkward cases — **before** they have any
 * provider account at all. That is what this is for.
 *
 * It signs the webhooks it emits with a real scheme, so the same verification code that
 * runs in production runs here. Nothing is stubbed out on the security path.
 *
 * Every edge case from PROVIDERS.md is reachable: overpayment, underpayment, payment
 * after expiry, duplicate delivery, reversal, and a deliberately invalid signature.
 */

import {
  type Channel,
  type Operation,
  type OperationSupport,
  type ProviderCapabilities,
} from "../../core/capabilities.ts";
import {
  type EventType,
  type InflowVariance,
  type NaijaPayEvent,
  type VirtualAccountInflow,
  classifyInflow,
} from "../../core/events.ts";
import { type Money, naira } from "../../core/money.ts";
import {
  type SignatureScheme,
  type SignatureStrength,
  computeSignature,
} from "../../core/signatures.ts";

export const MOCK_PROVIDER_NAME = "mock";

/** Money on the wire, in the shape both languages emit. */
function moneyToJson(amount: Money | null): { amount: number; currency: string } | null {
  return amount === null ? null : { amount: amount.amount, currency: amount.currency };
}

/**
 * The mock's default signing secret.
 *
 * Public on purpose: it is a mock, and a developer should be able to verify its
 * webhooks without configuring anything. It contains EXAMPLE so the repository's
 * live-key scan ignores it.
 */
export const MOCK_DEFAULT_SECRET = "sk_test_EXAMPLEmocksecret";

/**
 * The mock signs with Paystack's scheme — HMAC-SHA512 hex over the raw body — because
 * it is the strongest of the Tier 1 schemes, so code written against the mock works
 * unchanged against the strictest real provider.
 */
export const MOCK_SCHEME: SignatureScheme = {
  kind: "hmac-hex",
  header: "x-mock-signature",
  algorithm: "SHA-512",
  signs: "raw-body",
  strength: "full-body",
};

const ALL_OPERATIONS: Operation[] = [
  "checkout.create",
  "transactions.verify",
  "transactions.list",
  "refunds.create",
  "refunds.status",
  "virtualAccounts.createStatic",
  "virtualAccounts.createDynamic",
  "virtualAccounts.get",
  "virtualAccounts.list",
  "virtualAccounts.updateKyc",
  "virtualAccounts.deactivate",
  "virtualAccounts.listInflows",
  "splitAccounts.create",
  "splitAccounts.update",
  "splitAccounts.list",
  "splitAccounts.deactivate",
  "splits.create",
  "splits.update",
  "splits.list",
  "splits.settlements",
  "wallets.onboardCustomer",
  "wallets.open",
  "wallets.balance",
  "wallets.statement",
  "wallets.transfer",
  "wallets.freeze",
  "wallets.unfreeze",
  "wallets.close",
  "payouts.create",
  "payouts.createBulk",
  "payouts.status",
  "banks.list",
  "banks.resolveAccount",
  "balance.get",
  "plans.create",
  "subscriptions.create",
  "charges.chargeAuthorization",
  "mandates.create",
  "mandates.status",
  "mandates.debit",
  "mandates.cancel",
  "identity.verifyBvn",
  "identity.verifyNin",
  "webhooks.verify",
];

const CHANNELS: Channel[] = [
  "card",
  "bank_transfer",
  "ussd",
  "bank_account",
  "qr",
  "wallet",
  "mobile_money",
];

/**
 * The mock supports everything, so a developer can exercise the whole normalised API.
 * It is the only provider for which that is true, and the capability matrix labels it
 * as a testing tool rather than a real provider.
 */
export const mockCapabilities: ProviderCapabilities = {
  provider: MOCK_PROVIDER_NAME,
  operations: Object.fromEntries(
    ALL_OPERATIONS.map((operation): [Operation, OperationSupport] => [
      operation,
      operation === "virtualAccounts.createStatic"
        ? { requiredKyc: ["bvn"], notes: "Mirrors the real providers, which require a BVN." }
        : {},
    ]),
  ) as ProviderCapabilities["operations"],
  channels: CHANNELS,
  currencies: ["NGN", "GHS", "KES", "ZAR", "USD", "XOF"],
  webhookSignature: {
    strength: "full-body",
    header: MOCK_SCHEME.header,
    algorithm: "HMAC-SHA512 hex over the raw body",
    notes: "Matches Paystack's scheme, the strongest of the Tier 1 providers.",
  },
};

/** A signed webhook, ready to post at an endpoint or hand straight to a parser. */
export interface MockWebhook {
  /** The raw bytes to deliver. Verification must use exactly these. */
  readonly body: Uint8Array;
  readonly headers: Readonly<Record<string, string>>;
  /** The normalised event the body represents, for assertions in tests. */
  readonly event: NaijaPayEvent;
  /** The JSON text of the body, for logging and snapshots. */
  readonly text: string;
}

export interface MockOptions {
  readonly secret?: string;
  readonly scheme?: SignatureScheme;
  /** Fixed clock, so generated events and tests are deterministic. */
  readonly now?: () => Date;
  /** Fixed id sequence, so generated events are deterministic. */
  readonly idPrefix?: string;
}

export interface SimulateInflowOptions {
  readonly accountNumber?: string;
  readonly amountPaid: Money;
  /** Omit for a static account, where no amount is expected. */
  readonly expectedAmount?: Money | null;
  readonly reference?: string;
  readonly paidAt?: Date;
  readonly expiresAt?: Date;
  readonly sender?: { readonly name?: string; readonly bank?: string; readonly accountNumber?: string };
  readonly fees?: Money;
  readonly sessionId?: string;
  /** Produce a signature that will not verify, to test the failure path. */
  readonly invalidSignature?: boolean;
}

export class MockProvider {
  readonly capabilities = mockCapabilities;
  readonly scheme: SignatureScheme;
  readonly secret: string;

  readonly #now: () => Date;
  readonly #idPrefix: string;
  #counter = 0;

  constructor(options: MockOptions = {}) {
    this.secret = options.secret ?? MOCK_DEFAULT_SECRET;
    this.scheme = options.scheme ?? MOCK_SCHEME;
    this.#now = options.now ?? (() => new Date());
    this.#idPrefix = options.idPrefix ?? "evt_mock";
  }

  /** Deterministic event ids, so a duplicate can be produced on purpose. */
  nextEventId(): string {
    this.#counter += 1;
    return `${this.#idPrefix}_${String(this.#counter).padStart(4, "0")}`;
  }

  /**
   * Build and sign a webhook for any normalised event type.
   *
   * The body is the normalised event itself, which is what makes the mock readable: a
   * developer can see exactly what their handler will receive.
   */
  async buildWebhook(options: {
    readonly type: EventType;
    readonly data: unknown;
    readonly eventId?: string;
    readonly occurredAt?: Date;
    readonly invalidSignature?: boolean;
  }): Promise<MockWebhook> {
    const occurredAt = options.occurredAt ?? this.#now();
    const id = options.eventId ?? this.nextEventId();

    const payload = {
      id,
      event: options.type,
      occurred_at: occurredAt.toISOString(),
      provider: MOCK_PROVIDER_NAME,
      data: options.data,
    };

    const text = JSON.stringify(payload);
    const body = new TextEncoder().encode(text);

    const signature = options.invalidSignature
      ? // Deliberately wrong, and obviously so if it ever shows up in a log.
        "0".repeat(128)
      : await computeSignature(this.scheme, body, this.secret);

    const strength: SignatureStrength = options.invalidSignature
      ? "unverified"
      : this.scheme.strength;

    return {
      body,
      text,
      headers: {
        "content-type": "application/json",
        [this.scheme.header]: signature,
      },
      event: {
        id,
        type: options.type,
        occurredAt,
        provider: MOCK_PROVIDER_NAME,
        signatureStrength: strength,
        data: options.data,
        raw: payload,
        providerEvent: options.type,
      },
    };
  }

  /**
   * Simulate money arriving in a virtual account.
   *
   * The variance and lateness are computed by the same `classifyInflow` the real
   * adapters use, so a test cannot accidentally assert against a different rule than
   * production applies.
   */
  async simulateInflow(options: SimulateInflowOptions): Promise<MockWebhook> {
    const paidAt = options.paidAt ?? this.#now();
    const expectedAmount = options.expectedAmount ?? null;

    const { variance, varianceAmount, isLate } = classifyInflow({
      expectedAmount,
      amountPaid: options.amountPaid,
      paidAt,
      ...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }),
    });

    const inflow: VirtualAccountInflow = {
      reference: options.reference ?? `inflow_mock_${String(this.#counter + 1).padStart(4, "0")}`,
      // An obviously fake NUBAN, and one the redactor will mask in logs.
      accountNumber: options.accountNumber ?? "0123456789",
      expectedAmount,
      amountPaid: options.amountPaid,
      fees: options.fees ?? null,
      settledAmount: null,
      sender: options.sender
        ? {
            ...(options.sender.name === undefined ? {} : { name: options.sender.name }),
            ...(options.sender.bank === undefined ? {} : { bank: options.sender.bank }),
            ...(options.sender.accountNumber === undefined
              ? {}
              : { accountNumber: options.sender.accountNumber }),
          }
        : { name: "ADA OBI", bank: "Access Bank", accountNumber: "9876543210" },
      sessionId: options.sessionId ?? null,
      paidAt,
      expiresAt: options.expiresAt ?? null,
      variance,
      varianceAmount,
      isLate,
    };

    // The wire payload is deliberately snake_case and identical in both languages, so a
    // fixture recorded from the mock can drive the TypeScript and Python test suites
    // alike. The *parsed* event stays idiomatic per language; only the bytes are shared.
    return await this.buildWebhook({
      type: "virtual_account.credited",
      data: {
        reference: inflow.reference,
        account_number: inflow.accountNumber,
        expected_amount: moneyToJson(inflow.expectedAmount),
        amount_paid: moneyToJson(inflow.amountPaid),
        fees: moneyToJson(inflow.fees),
        variance: inflow.variance,
        variance_amount: moneyToJson(inflow.varianceAmount),
        is_late: inflow.isLate,
        sender: {
          name: inflow.sender?.name ?? null,
          bank: inflow.sender?.bank ?? null,
          account_number: inflow.sender?.accountNumber ?? null,
        },
        session_id: inflow.sessionId,
      },
      occurredAt: paidAt,
      ...(options.invalidSignature === undefined
        ? {}
        : { invalidSignature: options.invalidSignature }),
    });
  }

  /** Simulate a collection reaching a terminal state. */
  async simulatePayment(options: {
    readonly status: "successful" | "failed" | "pending" | "reversed";
    readonly amount?: Money;
    readonly reference?: string;
    readonly invalidSignature?: boolean;
  }): Promise<MockWebhook> {
    const amount = options.amount ?? naira(5_000);
    return await this.buildWebhook({
      type: `payment.${options.status}` as EventType,
      data: {
        reference: options.reference ?? "order_mock_0001",
        status: options.status,
        amount: moneyToJson(amount),
        channel: "bank_transfer",
      },
      ...(options.invalidSignature === undefined
        ? {}
        : { invalidSignature: options.invalidSignature }),
    });
  }

  /** Simulate a payout reaching a terminal state, including a reversal. */
  async simulateTransfer(options: {
    readonly status: "successful" | "failed" | "reversed";
    readonly amount?: Money;
    readonly reference?: string;
  }): Promise<MockWebhook> {
    const amount = options.amount ?? naira(25_000);
    return await this.buildWebhook({
      type: `transfer.${options.status}` as EventType,
      data: {
        reference: options.reference ?? "payout_mock_0001",
        status: options.status,
        amount: moneyToJson(amount),
        recipient: { bank_code: "044", account_number: "0123456789", name: "ADA OBI" },
      },
    });
  }

  /**
   * Deliver a webhook to a URL.
   *
   * `send` is injectable so the whole loop can be tested with no network — which is
   * also how naija-pay's own test suite exercises it.
   */
  async deliver(
    webhook: MockWebhook,
    url: string,
    send: typeof globalThis.fetch = globalThis.fetch,
  ): Promise<{ readonly status: number }> {
    const response = await send(url, {
      method: "POST",
      headers: { ...webhook.headers },
      body: webhook.body,
    });
    return { status: response.status };
  }
}

/** Create a mock provider. Takes no keys, and reaches no network. */
export function mock(options: MockOptions = {}): MockProvider {
  return new MockProvider(options);
}

/**
 * Every inflow edge case, as a ready-made scenario set.
 *
 * Exported so a developer can loop over the awkward cases in their own test suite
 * instead of having to think of them. These are exactly the cases PROVIDERS.md says
 * each provider leaves to you.
 */
export const INFLOW_SCENARIOS: readonly {
  readonly name: string;
  readonly expectedVariance: InflowVariance;
  readonly options: SimulateInflowOptions;
}[] = [
  {
    name: "exact payment",
    expectedVariance: "exact",
    options: { expectedAmount: naira(5_000), amountPaid: naira(5_000) },
  },
  {
    name: "overpayment",
    expectedVariance: "overpayment",
    options: { expectedAmount: naira(5_000), amountPaid: naira(5_500) },
  },
  {
    name: "underpayment",
    expectedVariance: "underpayment",
    options: { expectedAmount: naira(5_000), amountPaid: naira(4_900) },
  },
  {
    name: "static account funding, no expected amount",
    expectedVariance: "unexpected",
    options: { expectedAmount: null, amountPaid: naira(12_000) },
  },
  {
    name: "late payment after the account expired",
    expectedVariance: "exact",
    options: {
      expectedAmount: naira(5_000),
      amountPaid: naira(5_000),
      expiresAt: new Date("2026-10-30T10:00:00.000Z"),
      paidAt: new Date("2026-10-30T10:20:00.000Z"),
    },
  },
  {
    name: "late and underpaid at once",
    expectedVariance: "underpayment",
    options: {
      expectedAmount: naira(5_000),
      amountPaid: naira(4_000),
      expiresAt: new Date("2026-10-30T10:00:00.000Z"),
      paidAt: new Date("2026-10-30T10:30:00.000Z"),
    },
  },
];
