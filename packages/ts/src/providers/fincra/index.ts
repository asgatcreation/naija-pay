/**
 * The Fincra adapter.
 *
 * Read from Fincra's current documentation on 2026-11-11, endpoint by endpoint from the
 * OpenAPI document each reference page embeds. See `capabilities.ts` for what is
 * supported and why, and PROVIDERS.md for the findings.
 *
 * Six Fincra-specific traps this adapter absorbs:
 *
 * 1. **The auth header is not `Authorization`.** Fincra takes `api-key: <secret>`. A
 *    Bearer token is simply ignored, and the reply is "No API key found in request".
 * 2. **Two envelope keys for one meaning.** `{"status": true}` on checkout endpoints,
 *    `{"success": true}` on payouts, banks and wallets. Both are accepted.
 * 3. **`success: true` does not mean the payout settled.** Fincra's own documentation
 *    says so: it means the request was accepted. `data.status` is the answer, and
 *    `processing` is a pending payout.
 * 4. **Six decimal places.** Fincra reports fees like `9090.909091` and balances like
 *    `4145.558824`. No currency has six decimal places, so an amount that cannot be
 *    represented exactly in minor units is reported as null rather than rounded, and the
 *    exact figure stays in `raw`.
 * 5. **A payout can be waiting for a document.** `isDocumentRequired` on a created
 *    payout means nothing moves until a file is uploaded — Fincra's equivalent of
 *    Monnify's OTP gate.
 * 6. **The webhook signature is over a re-serialisation.** Fincra documents HMAC-SHA512
 *    over `JSON.stringify({event, data})`, which is not the raw bytes. `verifyWebhook`
 *    tries the raw body first and says which input matched.
 */

import type { Channel } from "../../core/capabilities.ts";
import { assertSupported, type Operation } from "../../core/capabilities.ts";
import {
  ConfigurationError,
  DuplicateReferenceError,
  errorClassForStatus,
  InsufficientFundsError,
  KycRequiredError,
  type NaijaPayError,
  NotFoundError,
  ValidationError,
} from "../../core/errors.ts";
import { HttpClient, type LogEvent, type RetryPolicy } from "../../core/http.ts";
import { type Money, majorToString, toMajor } from "../../core/money.ts";
import {
  computeSignature,
  constantTimeEqual,
  SCHEMES,
  type VerificationResult,
} from "../../core/signatures.ts";
import {
  CHANNEL_TO_FINCRA,
  FINCRA_LIVE_BASE_URL,
  FINCRA_NGN_VIRTUAL_ACCOUNT_CHANNELS,
  FINCRA_PROVIDER_NAME,
  FINCRA_SANDBOX_BASE_URL,
  fincraCapabilities,
  NOT_YET_IMPLEMENTED,
} from "./capabilities.ts";
import {
  type Bank,
  type BankAccount,
  type BvnVerification,
  enrich,
  type Page,
  type Payout,
  type Refund,
  type Transaction,
  toBank,
  toBvnVerification,
  toPage,
  toPayout,
  toRefund,
  toTransaction,
  toVirtualAccount,
  toWalletBalance,
  type VirtualAccount,
  type WalletBalance,
} from "./normalise.ts";

export * from "./capabilities.ts";
export * from "./normalise.ts";

export interface FincraOptions {
  /** The secret key, sent as the `api-key` header. */
  readonly secretKey: string;
  /**
   * The public key, sent as `x-pub-key` where Fincra accepts it.
   *
   * Safe to publish — it only identifies your account — and optional here, because no
   * endpoint this adapter calls requires it.
   */
  readonly publicKey?: string;
  /**
   * Your Fincra business id.
   *
   * Required by payouts, BVN verification and the wallet list, and sent as the
   * `x-business-id` header where Fincra wants a header instead of a field. It differs
   * between sandbox and live. `getBusiness()` will tell you yours.
   */
  readonly businessId?: string;
  /**
   * The **webhook secret key** — a third key, separate from the secret and public keys,
   * and the only one webhooks are signed with. Fincra's dashboard calls it the Webhook
   * Encryption Key.
   */
  readonly webhookSecretKey?: string;
  /**
   * Which Fincra to talk to. Defaults to `test`, which is the sandbox host.
   *
   * Fincra publishes no key prefix convention, so unlike Paystack and Flutterwave there
   * is nothing in the key to cross-check this against. The host is the whole of the
   * separation, which is why this adapter will not try to infer the environment from the
   * key: a wrong guess there would be worse than asking.
   */
  readonly environment?: "test" | "live";
  readonly timeoutMs?: number;
  readonly retry?: RetryPolicy;
  readonly onLog?: (event: LogEvent) => void;
  readonly fetch?: typeof globalThis.fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly onLiveKeyWarning?: (message: string) => void;
}

interface Envelope {
  /** Checkout endpoints. */
  status?: boolean | string;
  /** Payout, bank and wallet endpoints. Same meaning, different name. */
  success?: boolean;
  message?: string;
  data?: unknown;
}

/**
 * Fincra's error wording, mapped onto our typed errors.
 *
 * Fincra's own phrasing: "Invalid authentication credentials" and "No API key found in
 * request" where Paystack says "Invalid key". Each provider matches its own strings.
 */
function classifyFincraError(
  status: number,
  body: unknown,
): { error: typeof NaijaPayError; message?: string } | undefined {
  const bag = (body ?? {}) as Envelope;
  const message = typeof bag.message === "string" ? bag.message.toLowerCase() : "";

  if (message.includes("duplicate") || message.includes("already exists")) {
    return { error: DuplicateReferenceError };
  }
  if (message.includes("insufficient") || message.includes("balance")) {
    return { error: InsufficientFundsError };
  }
  if (message.includes("bvn") || message.includes("kyc") || message.includes("verification")) {
    return { error: KycRequiredError };
  }
  // Fincra gates products per business and whitelists IPs, and says so in prose.
  // Reported as configuration, not authentication: the key is fine.
  if (
    message.includes("not enabled") ||
    message.includes("not allowed") ||
    message.includes("whitelist") ||
    message.includes("contact support")
  ) {
    return {
      error: ConfigurationError,
      message:
        `fincra: ${bag.message} — this is a configuration or entitlement problem rather ` +
        "than a bad key. Fincra gates products per business and can also require your " +
        "server's IP to be whitelisted under Settings.",
    };
  }
  if (status === 404 || message.includes("not found")) return { error: NotFoundError };
  if (status === 400 || status === 422) return { error: ValidationError };
  return undefined;
}

/** How Fincra's own error strings reach `KycRequiredError` with the right field named. */
const NGN_VIRTUAL_ACCOUNT_CURRENCY = "NGN";

/**
 * Everything about a static-virtual-account request that Fincra would reject.
 *
 * All of it is refused locally with the field named, because Fincra's own rejections do
 * not say which field was wrong. Kept out of the method so the request body stays
 * readable, and returns the normalised currency the body needs.
 *
 * The `channel` is the partner bank. Two of the nine Fincra publishes are disabled --
 * `bold` and `providus` -- and asking for one of those is refused with the table as the
 * reason rather than sent and failed.
 */
function checkStaticVirtualAccountRequest(options: {
  readonly currency: string;
  readonly accountType: "individual" | "corporate";
  readonly firstName?: string;
  readonly lastName?: string;
  readonly businessName?: string;
  readonly bvnName?: string;
  readonly bvn?: string;
  readonly channel?: string;
}): string {
  const currency = options.currency.toUpperCase();

  if (currency === NGN_VIRTUAL_ACCOUNT_CURRENCY && !options.bvn) {
    throw new KycRequiredError(
      "fincra: an NGN virtual account requires a bvn. Fincra's own documentation is " +
        "explicit about it, and the request is rejected without one.",
      {
        provider: FINCRA_PROVIDER_NAME,
        operation: "virtualAccounts.createStatic",
        required: ["bvn"],
      },
    );
  }

  if (options.accountType === "corporate" && (!options.businessName || !options.bvnName)) {
    throw new ValidationError(
      "fincra: a corporate virtual account requires both businessName and bvnName, " +
        "and bvnName must match the name on the BVN. Fincra rejects a mismatch " +
        "without saying which field was wrong.",
      { provider: FINCRA_PROVIDER_NAME, operation: "virtualAccounts.createStatic" },
    );
  }

  if (options.accountType === "individual" && (!options.firstName || !options.lastName)) {
    throw new ValidationError(
      "fincra: an individual virtual account requires both firstName and lastName.",
      { provider: FINCRA_PROVIDER_NAME, operation: "virtualAccounts.createStatic" },
    );
  }

  if (options.channel !== undefined) {
    const enabled = FINCRA_NGN_VIRTUAL_ACCOUNT_CHANNELS[options.channel];
    if (enabled === undefined) {
      throw new ValidationError(
        `fincra: "${options.channel}" is not one of the bank channels Fincra ` +
          `publishes (${Object.keys(FINCRA_NGN_VIRTUAL_ACCOUNT_CHANNELS).join(", ")}).`,
        { provider: FINCRA_PROVIDER_NAME, operation: "virtualAccounts.createStatic" },
      );
    }
    if (!enabled) {
      throw new ValidationError(
        `fincra: the "${options.channel}" bank channel is published as DISABLED in ` +
          "Fincra's own documentation, so an account cannot be issued there. Pick an " +
          "enabled channel, or omit channel and let Fincra choose.",
        { provider: FINCRA_PROVIDER_NAME, operation: "virtualAccounts.createStatic" },
      );
    }
  }

  return currency;
}

export class FincraProvider {
  readonly name = FINCRA_PROVIDER_NAME;
  readonly capabilities = fincraCapabilities;
  readonly notYetImplemented = NOT_YET_IMPLEMENTED;
  readonly #http: HttpClient;
  readonly #businessId: string | undefined;
  readonly #webhookSecretKey: string | undefined;

  constructor(options: FincraOptions) {
    const key = options.secretKey?.trim();
    if (!key) {
      throw new ConfigurationError(
        "fincra: secretKey is required. It is the value sent as the api-key header, " +
          "from Settings > API keys and webhook Configuration on the dashboard.",
        { provider: FINCRA_PROVIDER_NAME },
      );
    }

    const declared = options.environment ?? "test";
    if (declared === "live" && !isProductionEnvironment()) {
      (options.onLiveKeyWarning ?? defaultLiveKeyWarning)(
        "fincra: environment is 'live' outside a production environment, so this client " +
          "is pointed at api.fincra.com. Real money will move. Fincra publishes no key " +
          "prefix, so the environment is the only signal and nothing else can catch this.",
      );
    }

    this.#businessId = options.businessId?.trim() || undefined;
    this.#webhookSecretKey = options.webhookSecretKey?.trim() || undefined;

    this.#http = new HttpClient({
      provider: FINCRA_PROVIDER_NAME,
      baseUrl: declared === "live" ? FINCRA_LIVE_BASE_URL : FINCRA_SANDBOX_BASE_URL,
      headers: {
        // Not `authorization`. Fincra ignores a Bearer token entirely.
        "api-key": key,
        ...(options.publicKey ? { "x-pub-key": options.publicKey.trim() } : {}),
        ...(this.#businessId ? { "x-business-id": this.#businessId } : {}),
      },
      classifyError: classifyFincraError,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.retry === undefined ? {} : { retry: options.retry }),
      ...(options.onLog === undefined ? {} : { onLog: options.onLog }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    });
  }

  // ------------------------------------------------------------------ plumbing

  /**
   * Unwrap Fincra's envelope, which has two names for its one success field.
   *
   * `status` on checkout, `success` elsewhere. Either being explicitly false is a
   * failure; both being absent is treated as success, so an endpoint that spells it a
   * third way does not fail every call.
   */
  async #call<T = unknown>(options: {
    method: "GET" | "POST" | "PUT" | "DELETE";
    path: string;
    operation: Operation;
    safety: "safe" | "unsafe" | "money-moving";
    body?: unknown;
    query?: Record<string, string | number | boolean | undefined>;
    headers?: Record<string, string>;
    reference?: string;
  }): Promise<{ data: T; message: string }> {
    assertSupported(this.capabilities, options.operation);

    const response = await this.#http.request<Envelope>({
      method: options.method,
      path: options.path,
      operation: options.operation,
      safety: options.safety,
      ...(options.body === undefined ? {} : { body: options.body }),
      ...(options.query === undefined ? {} : { query: options.query }),
      ...(options.headers === undefined ? {} : { headers: options.headers }),
      ...(options.reference === undefined ? {} : { reference: options.reference }),
    });

    const envelope = response.body ?? {};
    const ok = envelope.success ?? envelope.status;
    const failed = ok === false || ok === "false" || ok === "error";

    if (failed) {
      const classified = classifyFincraError(response.status, envelope);
      const ErrorClass = classified?.error ?? errorClassForStatus(response.status);
      throw new ErrorClass(classified?.message ?? envelope.message ?? "fincra reported a failure", {
        provider: FINCRA_PROVIDER_NAME,
        operation: options.operation,
        httpStatus: response.status,
        ...(envelope.message === undefined ? {} : { providerMessage: envelope.message }),
        ...(response.requestId === undefined ? {} : { requestId: response.requestId }),
      });
    }

    return { data: envelope.data as T, message: envelope.message ?? "" };
  }

  #requireBusinessId(operation: Operation): string {
    if (this.#businessId === undefined) {
      throw new ConfigurationError(
        "fincra: businessId is required for this call. It identifies your business, " +
          "differs between sandbox and live, and getBusiness() will tell you yours.",
        { provider: FINCRA_PROVIDER_NAME, operation },
      );
    }
    return this.#businessId;
  }

  #assertSupportedCurrency(amount: Money, operation: Operation): void {
    const supported = this.capabilities.currencies ?? [];
    if (!supported.includes(amount.currency)) {
      throw new ValidationError(
        `fincra: ${amount.currency} is not one of the currencies Fincra documents ` +
          `(${supported.join(", ")}).`,
        { provider: FINCRA_PROVIDER_NAME, operation },
      );
    }
  }

  // ---------------------------------------------------------------- collections

  /**
   * Create a hosted checkout and return its link.
   *
   * `reference` is your own and comes back as `merchantReference`, which is what
   * `verifyTransaction` takes.
   */
  async createCheckout(options: {
    readonly amount: Money;
    readonly email: string;
    readonly name: string;
    readonly reference: string;
    readonly phone?: string;
    readonly channels?: readonly Channel[];
    readonly defaultChannel?: Channel;
    readonly callbackUrl?: string;
    readonly feeBearer?: "customer" | "business";
    readonly metadata?: Record<string, string | number | boolean>;
    /** For a cross-currency checkout, from the quote endpoint. */
    readonly quoteReference?: string;
  }): Promise<{
    readonly reference: string;
    readonly checkoutUrl: string;
    readonly payCode: string | null;
    readonly provider: string;
    readonly raw: unknown;
  }> {
    this.#assertSupportedCurrency(options.amount, "checkout.create");

    // Every unsupported channel is named at once, rather than one per attempt, and in
    // the same words the Python package uses.
    const unsupported = (options.channels ?? []).filter(
      (channel) => CHANNEL_TO_FINCRA[channel] === undefined,
    );
    if (unsupported.length > 0) {
      throw new ValidationError(
        `fincra does not support the channel(s): ${unsupported.join(", ")}. ` +
          "See the capability matrix in PROVIDERS.md.",
        { provider: FINCRA_PROVIDER_NAME, operation: "checkout.create" },
      );
    }
    const paymentMethods = options.channels?.map((channel) => CHANNEL_TO_FINCRA[channel] as string);

    const defaultMethod =
      options.defaultChannel === undefined ? undefined : CHANNEL_TO_FINCRA[options.defaultChannel];
    if (options.defaultChannel !== undefined && defaultMethod === undefined) {
      throw new ValidationError(`fincra does not support the channel: ${options.defaultChannel}.`, {
        provider: FINCRA_PROVIDER_NAME,
        operation: "checkout.create",
      });
    }

    const { data } = await this.#call<{ link?: string; payCode?: string; reference?: string }>({
      method: "POST",
      path: "/checkout/payments",
      operation: "checkout.create",
      // Keyed on your reference, so a replay returns a link for the same payment.
      safety: "safe",
      body: {
        currency: options.amount.currency,
        // Decimal major units, converted and round-trip-checked. Never amount.amount.
        amount: toMajor(options.amount),
        customer: {
          name: options.name,
          email: options.email,
          ...(options.phone === undefined ? {} : { phoneNumber: options.phone }),
        },
        reference: options.reference,
        ...(paymentMethods === undefined ? {} : { paymentMethods }),
        ...(defaultMethod === undefined ? {} : { defaultPaymentMethod: defaultMethod }),
        ...(options.callbackUrl === undefined ? {} : { redirectUrl: options.callbackUrl }),
        ...(options.feeBearer === undefined ? {} : { feeBearer: options.feeBearer }),
        ...(options.quoteReference === undefined ? {} : { quoteReference: options.quoteReference }),
        ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
      },
    });

    return {
      reference: options.reference,
      checkoutUrl: data.link ?? "",
      payCode: data.payCode ?? null,
      provider: FINCRA_PROVIDER_NAME,
      raw: data,
    };
  }

  /**
   * Verify a payment by **your** reference.
   *
   * Fincra has no verify-by-its-own-reference route for checkout, which is the opposite
   * of Flutterwave. The `x-business-id` header is required on this call, and only this
   * call, so a client configured without a business id is told so here.
   */
  async verifyTransaction(reference: string): Promise<Transaction> {
    const businessId = this.#requireBusinessId("transactions.verify");
    const { data } = await this.#call({
      method: "GET",
      path: `/checkout/payments/merchant-reference/${encodeURIComponent(reference)}`,
      operation: "transactions.verify",
      safety: "safe",
      headers: { "x-business-id": businessId },
    });
    return toTransaction(data);
  }

  // ------------------------------------------------------------------- refunds

  /**
   * Refund a collection in full.
   *
   * Fincra takes only the collection's reference: there is no amount field, so a
   * **partial refund is not possible** through this API. Said plainly here because the
   * absence is easy to mistake for an omission in the adapter.
   */
  async createRefund(collectionReference: string): Promise<Refund> {
    const { data } = await this.#call({
      method: "POST",
      path: "/collections/refund",
      operation: "refunds.create",
      // Moves money back to a customer. Never retried.
      safety: "money-moving",
      reference: collectionReference,
      body: { transReference: collectionReference },
    });
    return toRefund(data);
  }

  async getRefund(reference: string): Promise<Refund> {
    const { data } = await this.#call({
      method: "GET",
      path: `/collections/refund/${encodeURIComponent(reference)}`,
      operation: "refunds.status",
      safety: "safe",
    });
    return toRefund(data);
  }

  async listRefunds(): Promise<Page<Refund>> {
    const { data } = await this.#call({
      method: "GET",
      path: "/collections/refund",
      operation: "refunds.status",
      safety: "safe",
      query: { business: this.#requireBusinessId("refunds.status") },
    });
    return toPage(data, toRefund);
  }

  // ----------------------------------------------------------- virtual accounts

  /**
   * Request a permanent virtual account.
   *
   * NGN requires a BVN, and a corporate account additionally requires `businessName`
   * and `bvnName`, which Fincra matches against the name on the BVN. Both are enforced
   * here rather than by a provider rejection that names no field.
   *
   * The `channel` is the partner bank. Two of the nine Fincra publishes are disabled —
   * `bold` and `providus` — and asking for one of those is refused locally with the
   * table as the reason.
   */
  async createVirtualAccount(options: {
    readonly currency: string;
    readonly accountType: "individual" | "corporate";
    readonly reference?: string;
    readonly firstName?: string;
    readonly lastName?: string;
    readonly businessName?: string;
    readonly bvnName?: string;
    readonly email?: string;
    readonly phone?: string;
    readonly bvn?: string;
    readonly channel?: string;
  }): Promise<VirtualAccount> {
    const currency = checkStaticVirtualAccountRequest(options);

    const kyc: Record<string, unknown> = {
      ...(options.firstName === undefined ? {} : { firstName: options.firstName }),
      ...(options.lastName === undefined ? {} : { lastName: options.lastName }),
      ...(options.businessName === undefined ? {} : { businessName: options.businessName }),
      ...(options.bvnName === undefined ? {} : { bvnName: options.bvnName }),
      ...(options.email === undefined ? {} : { email: options.email }),
      ...(options.phone === undefined ? {} : { phone: options.phone }),
      ...(options.bvn === undefined ? {} : { bvn: options.bvn }),
    };

    const { data } = await this.#call({
      method: "POST",
      path: "/profile/virtual-accounts/requests",
      operation: "virtualAccounts.createStatic",
      // Creates a KYC request. Not keyed on anything we own unless a reference is given,
      // so never repeated automatically.
      safety: "unsafe",
      body: {
        currency,
        accountType: options.accountType,
        KYCInformation: kyc,
        ...(options.channel === undefined ? {} : { channel: options.channel }),
        ...(options.reference === undefined ? {} : { merchantReference: options.reference }),
      },
      ...(options.reference === undefined ? {} : { reference: options.reference }),
    });

    return toVirtualAccount(data, {
      ...(options.reference === undefined ? {} : { reference: options.reference }),
      kind: "static",
    });
  }

  /**
   * Request a temporary virtual account for one payment.
   *
   * Fincra takes the amount as a **string** on this one endpoint, while every other
   * endpoint takes a number. `expiresAt` is required.
   */
  async createDynamicVirtualAccount(options: {
    readonly amount: Money;
    readonly expiresAt: Date | string;
    readonly reference?: string;
    readonly channel?: string;
  }): Promise<VirtualAccount> {
    if (options.amount.currency !== NGN_VIRTUAL_ACCOUNT_CURRENCY) {
      throw new ValidationError(
        "fincra: a temporary virtual account is NGN only, which is what Fincra's " +
          "documentation for this endpoint says.",
        { provider: FINCRA_PROVIDER_NAME, operation: "virtualAccounts.createDynamic" },
      );
    }

    const expiresAt =
      options.expiresAt instanceof Date ? options.expiresAt.toISOString() : options.expiresAt;

    const { data } = await this.#call({
      method: "POST",
      path: "/profile/virtual-accounts/transfer",
      operation: "virtualAccounts.createDynamic",
      safety: "unsafe",
      body: {
        // A string, deliberately: Fincra's schema for this endpoint types amount as a
        // string, unlike every other endpoint. The conversion is still checked.
        amount: majorToString(options.amount),
        expiresAt,
        ...(options.reference === undefined ? {} : { merchantReference: options.reference }),
        ...(options.channel === undefined ? {} : { channel: options.channel }),
      },
      ...(options.reference === undefined ? {} : { reference: options.reference }),
    });

    return toVirtualAccount(data, {
      ...(options.reference === undefined ? {} : { reference: options.reference }),
      kind: "dynamic",
    });
  }

  /** One virtual account, by Fincra's `_id`. */
  async getVirtualAccount(id: string): Promise<VirtualAccount> {
    const { data } = await this.#call({
      method: "GET",
      path: `/profile/virtual-accounts/${encodeURIComponent(id)}`,
      operation: "virtualAccounts.get",
      safety: "safe",
    });
    return toVirtualAccount(data);
  }

  async listVirtualAccounts(
    options: {
      readonly page?: number;
      readonly perPage?: number;
      readonly currency?: string;
      readonly status?: "pending" | "approved" | "declined" | "expired" | "closed" | "reviewed";
      readonly accountType?: "individual" | "corporate";
      readonly reference?: string;
    } = {},
  ): Promise<Page<VirtualAccount>> {
    const { data } = await this.#call({
      method: "GET",
      path: "/profile/virtual-accounts",
      operation: "virtualAccounts.list",
      safety: "safe",
      query: {
        ...(options.page === undefined ? {} : { page: options.page }),
        ...(options.perPage === undefined ? {} : { perPage: options.perPage }),
        ...(options.currency === undefined ? {} : { currency: options.currency }),
        ...(options.status === undefined ? {} : { status: options.status }),
        ...(options.accountType === undefined ? {} : { accountType: options.accountType }),
        ...(options.reference === undefined ? {} : { merchantReference: options.reference }),
      },
    });
    return toPage(data, (item) => toVirtualAccount(item));
  }

  /**
   * Find a customer's virtual accounts by their BVN.
   *
   * Fincra masks the response: account numbers, names and emails come back as runs of
   * asterisks. Useful for "does this person already have an account", not for reading
   * the account number back.
   */
  async findVirtualAccountsByBvn(bvn: string): Promise<Page<VirtualAccount>> {
    const { data } = await this.#call({
      method: "GET",
      path: "/profile/virtual-accounts/bvn",
      operation: "virtualAccounts.list",
      safety: "safe",
      query: { bvn, business: this.#requireBusinessId("virtualAccounts.list") },
    });
    return toPage(data, (item) => toVirtualAccount(item));
  }

  /** Collections that landed in one virtual account. */
  async listVirtualAccountInflows(options: {
    readonly virtualAccountId: string;
  }): Promise<Page<Transaction>> {
    const { data } = await this.#call({
      method: "GET",
      path: "/collections",
      operation: "virtualAccounts.listInflows",
      safety: "safe",
      query: {
        business: this.#requireBusinessId("virtualAccounts.listInflows"),
        virtualAccount: options.virtualAccountId,
      },
    });
    return toPage(data, toTransaction);
  }

  // ------------------------------------------------------------------- payouts

  /**
   * Create a payout to a bank account.
   *
   * **`success: true` does not mean the money arrived.** Fincra's documentation says so
   * in as many words: it confirms the request was handled. The returned payout's
   * `status` is the answer, and `processing` means pending.
   *
   * A cross-currency payout needs a `quoteReference` from Fincra's quote endpoint, and
   * quotes expire in 30 seconds. Never retried, whatever the transport does.
   */
  async createPayout(options: {
    readonly amount: Money;
    readonly reference: string;
    readonly destinationCurrency?: string;
    readonly description?: string;
    readonly beneficiary: {
      readonly accountNumber: string;
      readonly bankCode: string;
      readonly accountHolderName: string;
      readonly type?: "individual" | "corporate";
      readonly firstName?: string;
      readonly lastName?: string;
      readonly country?: string;
      readonly email?: string;
      readonly phone?: string;
    };
    readonly quoteReference?: string;
    readonly paymentDestination?: string;
  }): Promise<Payout> {
    this.#assertSupportedCurrency(options.amount, "payouts.create");
    const business = this.#requireBusinessId("payouts.create");
    const destinationCurrency = (
      options.destinationCurrency ?? options.amount.currency
    ).toUpperCase();

    if (destinationCurrency !== options.amount.currency && options.quoteReference === undefined) {
      throw new ValidationError(
        `fincra: a cross-currency payout (${options.amount.currency} to ` +
          `${destinationCurrency}) requires a quoteReference. Generate one with Fincra's ` +
          "quote endpoint and send it within 30 seconds, which is how long a quote lasts.",
        { provider: FINCRA_PROVIDER_NAME, operation: "payouts.create" },
      );
    }

    const { data } = await this.#call({
      method: "POST",
      path: "/disbursements/payouts",
      operation: "payouts.create",
      safety: "money-moving",
      reference: options.reference,
      body: {
        business,
        sourceCurrency: options.amount.currency,
        destinationCurrency,
        // A number, not a string: Fincra's own page says "Do not send it as a string".
        amount: toMajor(options.amount),
        customerReference: options.reference,
        paymentDestination: options.paymentDestination ?? "bank_account",
        ...(options.description === undefined ? {} : { description: options.description }),
        ...(options.quoteReference === undefined ? {} : { quoteReference: options.quoteReference }),
        beneficiary: {
          accountHolderName: options.beneficiary.accountHolderName,
          accountNumber: options.beneficiary.accountNumber,
          bankCode: options.beneficiary.bankCode,
          type: options.beneficiary.type ?? "individual",
          country: options.beneficiary.country ?? "NG",
          ...(options.beneficiary.firstName === undefined
            ? {}
            : { firstName: options.beneficiary.firstName }),
          ...(options.beneficiary.lastName === undefined
            ? {}
            : { lastName: options.beneficiary.lastName }),
          ...(options.beneficiary.email === undefined ? {} : { email: options.beneficiary.email }),
          ...(options.beneficiary.phone === undefined ? {} : { phone: options.beneficiary.phone }),
        },
      },
    });
    return toPayout(data);
  }

  /** A payout by Fincra's own reference. */
  async getPayout(providerReference: string): Promise<Payout> {
    const { data } = await this.#call({
      method: "GET",
      path: `/disbursements/payouts/reference/${encodeURIComponent(providerReference)}`,
      operation: "payouts.status",
      safety: "safe",
    });
    return toPayout(data);
  }

  /** A payout by **your** `customerReference`, which is usually what you hold. */
  async getPayoutByReference(reference: string): Promise<Payout> {
    const { data } = await this.#call({
      method: "GET",
      path: `/disbursements/payouts/customer-reference/${encodeURIComponent(reference)}`,
      operation: "payouts.status",
      safety: "safe",
    });
    return toPayout(data);
  }

  /**
   * List payouts.
   *
   * Fincra's reference page documents this as a GET **with a request body**, which is
   * not a thing `fetch` can send and not a thing most servers read. The filters are sent
   * as query parameters instead, which is the only reading that can work over HTTP. That
   * discrepancy is recorded in PROVIDERS.md and is first on the list for the sandbox
   * harness to settle.
   */
  async listPayouts(
    options: {
      readonly page?: number;
      readonly perPage?: number;
      readonly sourceCurrency?: string;
      readonly destinationCurrency?: string;
      readonly status?: string;
      readonly dateFrom?: string;
      readonly dateTo?: string;
    } = {},
  ): Promise<Page<Payout>> {
    const { data } = await this.#call({
      method: "GET",
      path: "/disbursements/payouts",
      operation: "payouts.status",
      safety: "safe",
      query: {
        business: this.#requireBusinessId("payouts.status"),
        ...(options.page === undefined ? {} : { page: options.page }),
        ...(options.perPage === undefined ? {} : { perPage: options.perPage }),
        ...(options.sourceCurrency === undefined ? {} : { sourceCurrency: options.sourceCurrency }),
        ...(options.destinationCurrency === undefined
          ? {}
          : { destinationCurrency: options.destinationCurrency }),
        ...(options.status === undefined ? {} : { status: options.status }),
        ...(options.dateFrom === undefined ? {} : { dateFrom: options.dateFrom }),
        ...(options.dateTo === undefined ? {} : { dateTo: options.dateTo }),
      },
    });
    return toPage(data, toPayout);
  }

  // ---------------------------------------------------------- banks and balance

  /**
   * Banks and payout providers for a country or currency.
   *
   * At least one of `country` or `currency` is required, and this defaults to Nigeria
   * rather than making the common case say so.
   */
  async listBanks(
    options: {
      readonly country?: string;
      readonly currency?: string;
      readonly paymentDestination?:
        | "bank_account"
        | "mobile_money_wallet"
        | "cash_pick_up"
        | "settlement_account";
    } = {},
  ): Promise<readonly Bank[]> {
    const { data } = await this.#call<unknown[]>({
      method: "GET",
      path: "/core/banks",
      operation: "banks.list",
      safety: "safe",
      query: {
        country: options.country ?? (options.currency === undefined ? "NG" : undefined),
        ...(options.currency === undefined ? {} : { currency: options.currency }),
        ...(options.paymentDestination === undefined
          ? {}
          : { paymentDestination: options.paymentDestination }),
      },
    });
    return (Array.isArray(data) ? data : []).map(toBank);
  }

  /**
   * Resolve an account number to its holder's name.
   *
   * A **POST**, not a GET, and `type` is required: `nuban` for a Nigerian account
   * number, or `bank_account`, `iban`, `mobile_money` or `interac_etransfer` elsewhere.
   * Fincra does not echo the bank code back on a NUBAN resolve, so the adapter carries
   * the one you passed.
   */
  async resolveAccount(options: {
    readonly accountNumber: string;
    readonly bankCode: string;
    readonly type?: "bank_account" | "nuban" | "iban" | "mobile_money" | "interac_etransfer";
    readonly currency?: string;
  }): Promise<BankAccount> {
    const { data } = await this.#call<{ accountNumber?: string; accountName?: string }>({
      method: "POST",
      path: "/core/accounts/resolve",
      operation: "banks.resolveAccount",
      // A read, despite the verb.
      safety: "safe",
      body: {
        type: options.type ?? "nuban",
        accountNumber: options.accountNumber,
        bankCode: options.bankCode,
        ...(options.currency === undefined ? {} : { currency: options.currency }),
      },
    });

    return enrich({
      accountNumber: data.accountNumber ?? options.accountNumber,
      accountName: data.accountName ?? "",
      bankCode: options.bankCode,
    });
  }

  /** Every wallet balance, one per currency. */
  async getBalance(): Promise<readonly WalletBalance[]> {
    const { data } = await this.#call<unknown[]>({
      method: "GET",
      path: "/wallets",
      operation: "balance.get",
      safety: "safe",
      query: { businessID: this.#requireBusinessId("balance.get") },
    });
    return (Array.isArray(data) ? data : []).map(toWalletBalance);
  }

  /** One wallet, by Fincra's wallet id. */
  async getWallet(walletId: string): Promise<WalletBalance> {
    const { data } = await this.#call({
      method: "GET",
      path: `/wallets/${encodeURIComponent(walletId)}`,
      operation: "balance.get",
      safety: "safe",
    });
    return toWalletBalance(data);
  }

  /**
   * Your business profile, including the id every other call needs.
   *
   * The way to find your `businessId` when you do not have it: the `_id` in the result.
   * Declared under `balance.get` rather than as an operation of its own, because it is
   * configuration discovery rather than a payments capability.
   */
  async getBusiness(): Promise<{ readonly id: string | null; readonly raw: unknown }> {
    const { data } = await this.#call<{ _id?: string }>({
      method: "GET",
      path: "/profile/business/me",
      operation: "balance.get",
      safety: "safe",
    });
    return { id: data?._id ?? null, raw: data };
  }

  // ------------------------------------------------------------------ identity

  /**
   * Verify a BVN.
   *
   * Fincra returns a photograph of the person as base64. This adapter **drops it**: see
   * `toBvnVerification`. A BVN is sensitive under NDPA 2023 and a photograph more so, so
   * neither is logged and the photograph is not even carried in `raw`.
   */
  async verifyBvn(bvn: string): Promise<BvnVerification> {
    const { data } = await this.#call({
      method: "POST",
      path: "/core/bvn-verification",
      operation: "identity.verifyBvn",
      safety: "safe",
      body: { bvn, business: this.#requireBusinessId("identity.verifyBvn") },
    });
    return toBvnVerification(data);
  }

  // ------------------------------------------------------------------ webhooks

  /**
   * Verify a webhook from Fincra.
   *
   * `body` must be the raw bytes exactly as received.
   *
   * Fincra's documented scheme is HMAC-SHA512, hex, in the `signature` header, keyed
   * with the **webhook secret key** — the third key on the dashboard, not the API secret
   * and not the public key.
   *
   * The complication is what gets hashed. Fincra's samples hash
   * `JSON.stringify({event, data})` — a re-serialisation of the parsed payload. That is
   * not the bytes that arrived, and whether it reproduces them depends on key order and
   * on separators: their Node sample leans on V8's ordering and their Python sample pins
   * `separators=(',', ':')`. So this method tries two inputs, in this order:
   *
   * 1. **The raw body**, which is what a signature ought to cover and what matches when
   *    Fincra signs the bytes it is about to send.
   * 2. **A canonical compact re-serialisation** of `{event, data}` with no spaces,
   *    keys in the order they appear — which is what their samples compute.
   *
   * `matchedInput` says which one verified. A `canonical-reserialisation` match is a
   * real verification, not a guess: the secret still had to be known. But it is worth
   * knowing, because it means the signature does not cover the exact bytes, and that
   * observation is what we take to Fincra.
   */
  async verifyWebhook(options: {
    readonly body: Uint8Array;
    readonly headers: Readonly<Record<string, string>>;
  }): Promise<
    VerificationResult & { readonly matchedInput: "raw-body" | "canonical-reserialisation" | null }
  > {
    assertSupported(this.capabilities, "webhooks.verify");

    if (this.#webhookSecretKey === undefined) {
      throw new ConfigurationError(
        "fincra: webhookSecretKey is required to verify webhooks. It is a THIRD key, " +
          "separate from the secret and public keys — the dashboard calls it the Webhook " +
          "Encryption Key, under Settings > Portal Settings > Secret keys. Signing with " +
          "the API secret key will never match.",
        { provider: FINCRA_PROVIDER_NAME, operation: "webhooks.verify" },
      );
    }

    const headers = lowercaseKeys(options.headers);
    const provided = headers.signature;
    if (provided === undefined || provided === "") {
      return {
        verified: false,
        strength: "unverified",
        reason: 'the "signature" header is missing',
        matchedInput: null,
      };
    }

    const expectedFromRaw = await computeSignature(
      SCHEMES.fincra,
      options.body,
      this.#webhookSecretKey,
    );
    if (constantTimeEqual(provided, expectedFromRaw)) {
      return { verified: true, strength: "full-body", matchedInput: "raw-body" };
    }

    const canonical = canonicalFincraPayload(options.body);
    if (canonical !== null) {
      const expectedFromCanonical = await computeSignature(
        SCHEMES.fincra,
        canonical,
        this.#webhookSecretKey,
      );
      if (constantTimeEqual(provided, expectedFromCanonical)) {
        return {
          verified: true,
          // Honest: the signature covered a re-serialisation of the payload, not the
          // bytes. Everything in {event, data} is still authenticated, so this is
          // full-body in substance, and `matchedInput` is how a caller tells.
          strength: "full-body",
          matchedInput: "canonical-reserialisation",
        };
      }
    }

    return {
      verified: false,
      strength: "full-body",
      reason:
        "the signature did not match the raw body, nor a canonical re-serialisation of " +
        "{event, data}. Check that you are using the WEBHOOK secret key rather than the " +
        "API secret key, and that nothing parsed and re-serialised the body before it " +
        "reached here.",
      matchedInput: null,
    };
  }
}

/**
 * `{event, data}` re-serialised compactly, as Fincra's own samples compute it.
 *
 * Returns null when the body is not JSON or carries neither field, in which case there
 * is nothing to compare and the caller falls through to a failure.
 */
function canonicalFincraPayload(body: Uint8Array): Uint8Array | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;

  const bag = parsed as Record<string, unknown>;
  if (!("event" in bag) && !("data" in bag)) return null;

  // Only these two keys, in this order, which is what Fincra's samples pass to
  // JSON.stringify. JSON.stringify already emits no spaces, so this is the compact
  // form their Python sample pins with separators=(',', ':').
  return new TextEncoder().encode(JSON.stringify({ event: bag.event, data: bag.data }));
}

function lowercaseKeys(headers: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) out[key.toLowerCase()] = value;
  return out;
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

/** Create a Fincra provider. */
export function fincra(options: FincraOptions): FincraProvider {
  return new FincraProvider(options);
}
