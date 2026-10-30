/**
 * The Paystack adapter.
 *
 * Verified against <https://paystack.com/docs/api/> on 2026-10-25 and 2026-10-30.
 * Not yet sandbox-verified; see PROVIDERS.md for the status table.
 *
 * Three Paystack-specific traps this adapter absorbs, each from the docs:
 *
 * 1. **One host for test and live.** `api.paystack.co` serves both, and only the key
 *    says which you are in. A live key in staging moves real money with no URL change
 *    to catch it, so the key is checked against the declared environment at construction.
 * 2. **Transfer references are strictly formatted.** Minimum 16 characters, and only
 *    lowercase letters, digits, dash and underscore. We validate locally and explain,
 *    rather than letting a payout fail at the provider.
 * 3. **Transfers may require an OTP.** If OTP is enabled on the integration, a transfer
 *    comes back with status `otp` and cannot complete until a human enters a code sent
 *    to the business phone. That is reported as `pending` with `awaitingOtp` set, never
 *    as success.
 */

import { assertSupported, type Operation } from "../../core/capabilities.ts";
import {
  ConfigurationError,
  DuplicateReferenceError,
  InsufficientFundsError,
  KycRequiredError,
  type NaijaPayError,
  NotFoundError,
  ValidationError,
  errorClassForStatus,
} from "../../core/errors.ts";
import { HttpClient, type LogEvent, type RetryPolicy } from "../../core/http.ts";
import { BASIS_POINTS_TOTAL, type Money } from "../../core/money.ts";
import { looksLikeLiveKey, looksLikeTestKey } from "../../core/redact.ts";
import { SCHEMES, verifySignature } from "../../core/signatures.ts";
import type { Channel } from "../../core/capabilities.ts";
import {
  CHANNEL_TO_PAYSTACK,
  PAYSTACK_BASE_URL,
  PAYSTACK_PROVIDER_NAME,
  PAYSTACK_WEBHOOK_IPS,
  paystackCapabilities,
} from "./capabilities.ts";
import {
  type BankAccount,
  type Payout,
  type Refund,
  type Split,
  type SplitAccount,
  type Transaction,
  type VirtualAccount,
  enrich,
  toPayout,
  toRefund,
  toSplit,
  toSplitAccount,
  toTransaction,
  toVirtualAccount,
} from "./normalise.ts";

export * from "./capabilities.ts";
export * from "./normalise.ts";

export interface PaystackOptions {
  readonly secretKey: string;
  /** Checked against the key's own prefix; mismatches throw. */
  readonly environment?: "test" | "live";
  readonly timeoutMs?: number;
  readonly retry?: RetryPolicy;
  readonly onLog?: (event: LogEvent) => void;
  readonly fetch?: typeof globalThis.fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Called when a live key is used outside a recognised production environment. */
  readonly onLiveKeyWarning?: (message: string) => void;
}

/** Transfer references: min 16 chars, lowercase letters, digits, dash, underscore. */
const TRANSFER_REFERENCE = /^[a-z0-9_-]{16,50}$/;

interface Envelope {
  status?: boolean;
  message?: string;
  data?: unknown;
  meta?: unknown;
}

/**
 * Paystack's error codes, mapped onto our typed errors.
 *
 * Paystack mostly uses correct HTTP statuses, so this only covers the cases where the
 * status alone is ambiguous — chiefly the many different things a 400 can mean.
 */
function classifyPaystackError(
  status: number,
  body: unknown,
): { error: typeof NaijaPayError; message?: string } | undefined {
  const bag = (body ?? {}) as Envelope;
  const message = typeof bag.message === "string" ? bag.message.toLowerCase() : "";

  if (message.includes("duplicate") || message.includes("already exist")) {
    return { error: DuplicateReferenceError };
  }
  if (message.includes("insufficient")) return { error: InsufficientFundsError };
  if (message.includes("bvn") || message.includes("identification")) {
    return { error: KycRequiredError };
  }
  if (status === 404 || message.includes("not found")) return { error: NotFoundError };
  if (status === 400) return { error: ValidationError };
  return undefined;
}

export class PaystackProvider {
  readonly name = PAYSTACK_PROVIDER_NAME;
  readonly capabilities = paystackCapabilities;
  readonly #http: HttpClient;
  readonly #secretKey: string;

  constructor(options: PaystackOptions) {
    const key = options.secretKey?.trim();
    if (!key) {
      throw new ConfigurationError("paystack: secretKey is required", {
        provider: PAYSTACK_PROVIDER_NAME,
      });
    }
    if (!key.startsWith("sk_")) {
      throw new ConfigurationError(
        "paystack: secretKey must be a secret key beginning sk_test_ or sk_live_. " +
          "A public key (pk_) cannot authorise server-side calls.",
        { provider: PAYSTACK_PROVIDER_NAME },
      );
    }

    const declared = options.environment ?? (looksLikeLiveKey(key) ? "live" : "test");

    // The check that matters, because Paystack serves test and live from one host.
    if (declared === "test" && looksLikeLiveKey(key)) {
      throw new ConfigurationError(
        "paystack: a LIVE secret key was supplied while environment is 'test'. " +
          "Paystack serves test and live from the same host, so this would move real money. " +
          "Use a sk_test_ key, or set environment to 'live' deliberately.",
        { provider: PAYSTACK_PROVIDER_NAME },
      );
    }
    if (declared === "live" && looksLikeTestKey(key)) {
      throw new ConfigurationError(
        "paystack: a TEST secret key was supplied while environment is 'live'.",
        { provider: PAYSTACK_PROVIDER_NAME },
      );
    }

    if (declared === "live" && !isProductionEnvironment()) {
      const warning =
        "paystack: using a LIVE key outside a production environment. Real money will move.";
      (options.onLiveKeyWarning ?? defaultLiveKeyWarning)(warning);
    }

    this.#secretKey = key;
    this.#http = new HttpClient({
      provider: PAYSTACK_PROVIDER_NAME,
      baseUrl: PAYSTACK_BASE_URL,
      headers: { authorization: `Bearer ${key}` },
      classifyError: classifyPaystackError,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.retry === undefined ? {} : { retry: options.retry }),
      ...(options.onLog === undefined ? {} : { onLog: options.onLog }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    });
  }

  /** Unwrap Paystack's `{status, message, data}` envelope. */
  async #call<T = unknown>(options: {
    method: "GET" | "POST" | "PUT" | "DELETE";
    path: string;
    operation: Operation;
    safety: "safe" | "unsafe" | "money-moving";
    body?: unknown;
    query?: Record<string, string | number | boolean | undefined>;
    reference?: string;
  }): Promise<{ data: T; message: string; meta: unknown }> {
    assertSupported(this.capabilities, options.operation);

    const response = await this.#http.request<Envelope>({
      method: options.method,
      path: options.path,
      operation: options.operation,
      safety: options.safety,
      ...(options.body === undefined ? {} : { body: options.body }),
      ...(options.query === undefined ? {} : { query: options.query }),
      ...(options.reference === undefined ? {} : { reference: options.reference }),
    });

    const envelope = response.body ?? {};
    // Paystack normally signals failure with an HTTP status, but `status: false` on a
    // 2xx is possible, and treating that as success would be the worst kind of bug.
    if (envelope.status === false) {
      const ErrorClass = errorClassForStatus(response.status);
      throw new ErrorClass(envelope.message ?? "paystack reported a failure", {
        provider: PAYSTACK_PROVIDER_NAME,
        operation: options.operation,
        httpStatus: response.status,
        ...(envelope.message === undefined ? {} : { providerMessage: envelope.message }),
        ...(response.requestId === undefined ? {} : { requestId: response.requestId }),
      });
    }

    return {
      data: envelope.data as T,
      message: envelope.message ?? "",
      meta: envelope.meta,
    };
  }

  // ------------------------------------------------------------- collections

  /** Initialize a transaction and return the hosted checkout URL. */
  async createCheckout(options: {
    readonly amount: Money;
    readonly email: string;
    readonly reference?: string;
    readonly channels?: readonly Channel[];
    readonly callbackUrl?: string;
    readonly metadata?: Record<string, unknown>;
    readonly splitCode?: string;
    readonly subaccount?: string;
  }): Promise<{
    readonly reference: string;
    readonly checkoutUrl: string;
    readonly accessCode: string;
    readonly provider: string;
    readonly raw: unknown;
  }> {
    const channels = options.channels
      ?.map((channel) => CHANNEL_TO_PAYSTACK[channel])
      .filter((channel): channel is string => channel !== undefined);

    if (options.channels && channels && channels.length !== options.channels.length) {
      const unsupported = options.channels.filter((c) => !CHANNEL_TO_PAYSTACK[c]);
      throw new ValidationError(
        `paystack does not support the channel(s): ${unsupported.join(", ")}. ` +
          "See the capability matrix in PROVIDERS.md.",
        { provider: PAYSTACK_PROVIDER_NAME, operation: "checkout.create" },
      );
    }

    const { data } = await this.#call<{
      authorization_url: string;
      access_code: string;
      reference: string;
    }>({
      method: "POST",
      path: "/transaction/initialize",
      operation: "checkout.create",
      // Safe to retry: Paystack keys off our reference, so a replay returns the same
      // checkout rather than creating a second one.
      safety: "safe",
      body: {
        // Paystack documents amount as a string on this endpoint, unlike everywhere else.
        amount: String(options.amount.amount),
        currency: options.amount.currency,
        email: options.email,
        ...(options.reference === undefined ? {} : { reference: options.reference }),
        ...(channels && channels.length > 0 ? { channels } : {}),
        ...(options.callbackUrl === undefined ? {} : { callback_url: options.callbackUrl }),
        ...(options.metadata === undefined ? {} : { metadata: JSON.stringify(options.metadata) }),
        ...(options.splitCode === undefined ? {} : { split_code: options.splitCode }),
        ...(options.subaccount === undefined ? {} : { subaccount: options.subaccount }),
      },
    });

    return {
      reference: data.reference,
      checkoutUrl: data.authorization_url,
      accessCode: data.access_code,
      provider: PAYSTACK_PROVIDER_NAME,
      raw: data,
    };
  }

  /** Verify a transaction by the reference you used. */
  async verifyTransaction(reference: string): Promise<Transaction> {
    const { data } = await this.#call({
      method: "GET",
      path: `/transaction/verify/${encodeURIComponent(reference)}`,
      operation: "transactions.verify",
      safety: "safe",
    });
    return toTransaction(data);
  }

  async listTransactions(options: {
    readonly page?: number;
    readonly perPage?: number;
    readonly status?: string;
    readonly from?: string;
    readonly to?: string;
    readonly customer?: string;
  } = {}): Promise<{ readonly transactions: readonly Transaction[]; readonly meta: unknown }> {
    const { data, meta } = await this.#call<unknown[]>({
      method: "GET",
      path: "/transaction",
      operation: "transactions.list",
      safety: "safe",
      query: {
        page: options.page,
        perPage: options.perPage,
        status: options.status,
        from: options.from,
        to: options.to,
        customer: options.customer,
      },
    });
    return {
      transactions: (Array.isArray(data) ? data : []).map(toTransaction),
      meta,
    };
  }

  /** Refund a transaction, fully or partially. */
  async createRefund(options: {
    readonly transaction: string;
    readonly amount?: Money;
    readonly merchantNote?: string;
    readonly customerNote?: string;
  }): Promise<Refund> {
    const { data } = await this.#call({
      method: "POST",
      path: "/refund",
      operation: "refunds.create",
      // Never retried: a replayed refund could refund twice.
      safety: "money-moving",
      reference: options.transaction,
      body: {
        transaction: options.transaction,
        ...(options.amount === undefined
          ? {}
          : { amount: options.amount.amount, currency: options.amount.currency }),
        ...(options.merchantNote === undefined ? {} : { merchant_note: options.merchantNote }),
        ...(options.customerNote === undefined ? {} : { customer_note: options.customerNote }),
      },
    });
    return toRefund(data);
  }

  // -------------------------------------------------------- virtual accounts

  /**
   * Assign a Dedicated Virtual Account to a customer.
   *
   * Paystack's `assign` endpoint creates the customer, validates them and assigns the
   * account in one call, and returns only an acknowledgement — the account arrives by
   * webhook (`dedicatedaccount.assign.success`). We therefore return a pending record
   * rather than pretending to have an account number.
   */
  async createStaticVirtualAccount(options: {
    readonly email: string;
    readonly firstName: string;
    readonly lastName: string;
    readonly phone: string;
    readonly preferredBank: string;
    readonly bvn?: string;
    readonly country?: string;
    readonly splitCode?: string;
    readonly subaccount?: string;
  }): Promise<{ readonly status: "pending"; readonly message: string; readonly raw: unknown }> {
    assertSupported(this.capabilities, "virtualAccounts.createStatic");

    if (!options.bvn) {
      // Fail locally with the actionable error rather than an opaque provider rejection.
      throw new KycRequiredError(
        "paystack: a BVN is required to assign a dedicated virtual account under CBN rules.",
        {
          provider: PAYSTACK_PROVIDER_NAME,
          operation: "virtualAccounts.createStatic",
          required: ["bvn"],
        },
      );
    }

    const { data, message } = await this.#call({
      method: "POST",
      path: "/dedicated_account/assign",
      operation: "virtualAccounts.createStatic",
      safety: "safe",
      body: {
        email: options.email,
        first_name: options.firstName,
        last_name: options.lastName,
        phone: options.phone,
        preferred_bank: options.preferredBank,
        country: options.country ?? "NG",
        bvn: options.bvn,
        ...(options.splitCode === undefined ? {} : { split_code: options.splitCode }),
        ...(options.subaccount === undefined ? {} : { subaccount: options.subaccount }),
      },
    });

    return { status: "pending", message, raw: data };
  }

  async getVirtualAccount(id: string): Promise<VirtualAccount> {
    const { data } = await this.#call({
      method: "GET",
      path: `/dedicated_account/${encodeURIComponent(id)}`,
      operation: "virtualAccounts.get",
      safety: "safe",
    });
    return toVirtualAccount(data);
  }

  async listVirtualAccounts(
    options: { readonly active?: boolean; readonly currency?: string; readonly customer?: string } = {},
  ): Promise<readonly VirtualAccount[]> {
    const { data } = await this.#call<unknown[]>({
      method: "GET",
      path: "/dedicated_account",
      operation: "virtualAccounts.list",
      safety: "safe",
      query: {
        active: options.active,
        currency: options.currency,
        customer: options.customer,
      },
    });
    return (Array.isArray(data) ? data : []).map(toVirtualAccount);
  }

  async deactivateVirtualAccount(id: string): Promise<VirtualAccount> {
    const { data } = await this.#call({
      method: "DELETE",
      path: `/dedicated_account/${encodeURIComponent(id)}`,
      operation: "virtualAccounts.deactivate",
      safety: "unsafe",
    });
    return toVirtualAccount(data);
  }

  // ------------------------------------------------------ splits/subaccounts

  /** Create a subaccount that settles to a vendor's own bank account. */
  async createSplitAccount(options: {
    readonly businessName: string;
    readonly bankCode: string;
    readonly accountNumber: string;
    readonly percentageCharge: number;
    readonly description?: string;
  }): Promise<SplitAccount> {
    const { data } = await this.#call({
      method: "POST",
      path: "/subaccount",
      operation: "splitAccounts.create",
      safety: "safe",
      body: {
        business_name: options.businessName,
        // Paystack's reference lists `bank_code` while its own cURL sample sends
        // `settlement_bank`. Both are sent, which costs nothing and tolerates either.
        bank_code: options.bankCode,
        settlement_bank: options.bankCode,
        account_number: options.accountNumber,
        percentage_charge: options.percentageCharge,
        ...(options.description === undefined ? {} : { description: options.description }),
      },
    });
    return toSplitAccount(data);
  }

  async listSplitAccounts(): Promise<readonly SplitAccount[]> {
    const { data } = await this.#call<unknown[]>({
      method: "GET",
      path: "/subaccount",
      operation: "splitAccounts.list",
      safety: "safe",
    });
    return (Array.isArray(data) ? data : []).map(toSplitAccount);
  }

  /**
   * Create a transaction split.
   *
   * Shares arrive as basis points, because a percentage held as a float is how rounding
   * errors get into money. Paystack wants a percentage, so basis points are divided by
   * 100 — exact for every value, since 10000 bps is 100%.
   */
  async createSplit(options: {
    readonly name: string;
    readonly type: "percentage" | "flat";
    readonly currency: string;
    readonly parties: readonly { readonly account: string; readonly share: number }[];
    readonly bearerType?: "subaccount" | "account" | "all-proportional" | "all";
    readonly bearerSubaccount?: string;
  }): Promise<Split> {
    if (options.parties.length === 0) {
      throw new ValidationError("paystack: a split needs at least one party", {
        provider: PAYSTACK_PROVIDER_NAME,
        operation: "splits.create",
      });
    }

    for (const party of options.parties) {
      if (!Number.isInteger(party.share) || party.share < 0) {
        throw new ValidationError(
          `paystack: the share for "${party.account}" must be a non-negative integer ` +
            `(basis points for a percentage split, minor units for a flat one), got ${party.share}`,
          { provider: PAYSTACK_PROVIDER_NAME, operation: "splits.create" },
        );
      }
    }

    if (options.type === "percentage") {
      const total = options.parties.reduce((sum, p) => sum + p.share, 0);
      if (total > BASIS_POINTS_TOTAL) {
        throw new ValidationError(
          `paystack: the split shares total ${total} basis points, which is more than 100%`,
          { provider: PAYSTACK_PROVIDER_NAME, operation: "splits.create" },
        );
      }
    }

    const { data } = await this.#call({
      method: "POST",
      path: "/split",
      operation: "splits.create",
      safety: "safe",
      body: {
        name: options.name,
        type: options.type,
        currency: options.currency,
        subaccounts: options.parties.map((party) => ({
          subaccount: party.account,
          share: options.type === "percentage" ? party.share / 100 : party.share,
        })),
        bearer_type: options.bearerType ?? "all-proportional",
        ...(options.bearerSubaccount === undefined
          ? {}
          : { bearer_subaccount: options.bearerSubaccount }),
      },
    });
    return toSplit(data);
  }

  async listSplits(): Promise<readonly Split[]> {
    const { data } = await this.#call<unknown[]>({
      method: "GET",
      path: "/split",
      operation: "splits.list",
      safety: "safe",
    });
    return (Array.isArray(data) ? data : []).map(toSplit);
  }

  // ----------------------------------------------------------------- payouts

  async listBanks(
    options: { readonly country?: string; readonly perPage?: number } = {},
  ): Promise<readonly BankAccount["institution"][] | readonly unknown[]> {
    const { data } = await this.#call<unknown[]>({
      method: "GET",
      path: "/bank",
      operation: "banks.list",
      safety: "safe",
      query: { country: options.country ?? "nigeria", perPage: options.perPage ?? 1_000 },
    });
    return Array.isArray(data) ? data : [];
  }

  /** Resolve an account number to its registered name. */
  async resolveAccount(options: {
    readonly accountNumber: string;
    readonly bankCode: string;
  }): Promise<BankAccount> {
    const { data } = await this.#call<{ account_number: string; account_name: string }>({
      method: "GET",
      path: "/bank/resolve",
      operation: "banks.resolveAccount",
      safety: "safe",
      query: { account_number: options.accountNumber, bank_code: options.bankCode },
    });

    return enrich({
      accountNumber: data.account_number,
      accountName: data.account_name,
      bankCode: options.bankCode,
    });
  }

  /**
   * Send money to a bank account.
   *
   * Creates the transfer recipient first, which Paystack requires and which de-duplicates
   * on the account number, so repeating it is harmless.
   */
  async createPayout(options: {
    readonly amount: Money;
    readonly accountNumber: string;
    readonly bankCode: string;
    readonly accountName: string;
    readonly reference: string;
    readonly reason?: string;
  }): Promise<Payout> {
    assertSupported(this.capabilities, "payouts.create");

    if (!TRANSFER_REFERENCE.test(options.reference)) {
      throw new ValidationError(
        `paystack: the transfer reference "${options.reference}" is not acceptable. ` +
          "Paystack requires 16 to 50 characters, using only lowercase letters, digits, " +
          "dash and underscore.",
        { provider: PAYSTACK_PROVIDER_NAME, operation: "payouts.create" },
      );
    }

    // Creating the recipient is idempotent on the account number, so it is safe.
    const { data: recipient } = await this.#call<{ recipient_code: string }>({
      method: "POST",
      path: "/transferrecipient",
      operation: "payouts.create",
      safety: "safe",
      body: {
        type: "nuban",
        name: options.accountName,
        account_number: options.accountNumber,
        bank_code: options.bankCode,
        currency: options.amount.currency,
      },
    });

    const { data } = await this.#call({
      method: "POST",
      path: "/transfer",
      operation: "payouts.create",
      // The money-moving call. Never retried, never failed over.
      safety: "money-moving",
      reference: options.reference,
      body: {
        source: "balance",
        amount: options.amount.amount,
        currency: options.amount.currency,
        recipient: recipient.recipient_code,
        reference: options.reference,
        ...(options.reason === undefined ? {} : { reason: options.reason }),
      },
    });

    return toPayout(data);
  }

  async getPayout(reference: string): Promise<Payout> {
    const { data } = await this.#call({
      method: "GET",
      path: `/transfer/verify/${encodeURIComponent(reference)}`,
      operation: "payouts.status",
      safety: "safe",
    });
    return toPayout(data);
  }

  async getBalance(): Promise<readonly { readonly amount: number; readonly currency: string }[]> {
    const { data } = await this.#call<{ balance: number; currency: string }[]>({
      method: "GET",
      path: "/balance",
      operation: "balance.get",
      safety: "safe",
    });
    return (Array.isArray(data) ? data : []).map((entry) => ({
      amount: entry.balance,
      currency: entry.currency,
    }));
  }

  // ---------------------------------------------------------------- webhooks

  /**
   * Verify a webhook from Paystack.
   *
   * `body` must be the raw bytes exactly as received. Parsing or re-serialising first
   * guarantees a mismatch, and it is the single most common cause of "my signature does
   * not verify".
   */
  async verifyWebhook(options: {
    readonly body: Uint8Array;
    readonly headers: Readonly<Record<string, string>>;
  }) {
    assertSupported(this.capabilities, "webhooks.verify");
    return await verifySignature({
      scheme: SCHEMES.paystack,
      body: options.body,
      headers: options.headers,
      secret: this.#secretKey,
    });
  }

  /**
   * Whether a request came from one of Paystack's documented webhook IPs.
   *
   * Offered as a second check alongside the signature, never as a replacement: an IP
   * allowlist says where a request came from, not that its contents are intact.
   */
  isKnownWebhookIp(ip: string): boolean {
    return PAYSTACK_WEBHOOK_IPS.includes(ip);
  }
}

function isProductionEnvironment(): boolean {
  const env =
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
  const value = env.NODE_ENV ?? env.ENV ?? env.ENVIRONMENT ?? "";
  return value.toLowerCase() === "production";
}

function defaultLiveKeyWarning(message: string): void {
  // Deliberately loud, and on the error stream, so it is not lost in normal output.
  console.error(`\n*** ${message} ***\n`);
}

/** Create a Paystack provider. */
export function paystack(options: PaystackOptions): PaystackProvider {
  return new PaystackProvider(options);
}
