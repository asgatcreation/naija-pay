/**
 * The Monnify (Moniepoint) adapter.
 *
 * Read from Monnify's current documentation on 2026-11-11: the OpenAPI 3.1 document at
 * <https://developers.monnify.com/collection/monnify-collection.yml> and the webhook
 * guide at <https://developers.monnify.com/docs/webhooks>. See `capabilities.ts` for
 * what is supported and why, and PROVIDERS.md for the findings.
 *
 * Six Monnify-specific traps this adapter absorbs, each from the documentation:
 *
 * 1. **Authentication is two calls.** An API key and a secret key go as HTTP Basic to
 *    `/api/v1/auth/login`, which returns a Bearer token and an `expiresIn` in seconds.
 *    The token is cached and refreshed a minute early; a 401 clears it and the request
 *    is retried once with a fresh one, because a token can expire between being read
 *    and being used.
 * 2. **`requestSuccessful: false` arrives with HTTP 200.** Monnify signals failure
 *    inside the envelope as well as with status codes, so the envelope is always
 *    checked. `responseCode` is `"0"` on success and `99` on failure, and it is a
 *    string in some responses and a number in others.
 * 3. **`PENDING_AUTHORIZATION` means no money moved.** Two-factor disbursement is on by
 *    default, so a created payout normally comes back needing an OTP. Reading
 *    `requestSuccessful` alone would report it as sent. `createPayout` surfaces
 *    `awaitingOtp`, and `authorizePayout` is the second half of the flow.
 * 4. **Decimals on the wire, and strings in the replies.** Amounts go out as decimals
 *    in major units and come back as strings like `"100.00"`. Conversion happens here
 *    and nowhere else, through `toMajor`/`fromMajor`, which assert the round trip.
 * 5. **Dates are `dd/MM/yyyy hh:mm:ss a`.** Handing Monnify's `paidOn` to `new Date()`
 *    produces an Invalid Date or the wrong day. `normalise.ts` parses it explicitly.
 * 6. **`restrictPaymentSource` is never left to the server.** Monnify's documentation
 *    says it defaults to true, which would mean an account created without an allow-list
 *    rejects the very inflows you are waiting for. The sandbox returns `false` when the
 *    field is omitted (verified 2026-11-19), so the document and the server disagree.
 *    The adapter settles it by always sending the field explicitly — `true` exactly when
 *    you pass `allowedSources` — so neither default can surprise a caller.
 */

import type { Channel } from "../../core/capabilities.ts";
import { assertSupported, type Operation } from "../../core/capabilities.ts";
import {
  AuthenticationError,
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
import { type Money, toMajor } from "../../core/money.ts";
import { looksLikeLiveKey, looksLikeTestKey } from "../../core/redact.ts";
import { SCHEMES, type VerificationResult, verifySignature } from "../../core/signatures.ts";
import {
  CHANNEL_TO_MONNIFY,
  MONNIFY_LIVE_BASE_URL,
  MONNIFY_LOGIN_PATH,
  MONNIFY_PROVIDER_NAME,
  MONNIFY_SANDBOX_BASE_URL,
  MONNIFY_WEBHOOK_IPS,
  monnifyCapabilities,
  NOT_YET_IMPLEMENTED,
} from "./capabilities.ts";
import {
  type Balance,
  type Bank,
  type BankAccount,
  type BulkPayout,
  enrich,
  normaliseChannel,
  type Page,
  type Payout,
  type Refund,
  type SplitAccount,
  type Transaction,
  toBalance,
  toBank,
  toBulkPayout,
  toPage,
  toPayout,
  toRefund,
  toSplitAccount,
  toTransaction,
  toVirtualAccount,
  type VirtualAccount,
} from "./normalise.ts";

export * from "./capabilities.ts";
export * from "./normalise.ts";

export interface MonnifyOptions {
  /** The API key: `MK_TEST_…` in sandbox, `MK_PROD_…` in live. */
  readonly apiKey: string;
  /**
   * The secret key, which is also the **client secret** Monnify signs webhooks with.
   * One secret, two jobs — unlike Flutterwave, which has a separate webhook hash.
   */
  readonly secretKey: string;
  /**
   * Your contract code, from the dashboard. Required by every collection call, so it
   * is configuration rather than a per-call argument.
   */
  readonly contractCode?: string;
  /**
   * The Monnify wallet account number money is disbursed from.
   *
   * Monnify requires `sourceAccountNumber` on every transfer and on a balance lookup,
   * and it is a property of your integration, not of a payout.
   */
  readonly walletAccountNumber?: string;
  /**
   * Which Monnify to talk to. Defaults to `test`, which is the sandbox host — a
   * different machine from live, so the default cannot move real money.
   */
  readonly environment?: "test" | "live";
  readonly timeoutMs?: number;
  readonly retry?: RetryPolicy;
  readonly onLog?: (event: LogEvent) => void;
  readonly fetch?: typeof globalThis.fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly onLiveKeyWarning?: (message: string) => void;
  /** Overridable for tests; production reads the clock. */
  readonly now?: () => number;
}

interface Envelope {
  requestSuccessful?: boolean;
  responseMessage?: string;
  responseCode?: string | number;
  responseBody?: unknown;
}

/**
 * Monnify's error wording, mapped onto our typed errors.
 *
 * Monnify's own phrasing, which is its own: it says "Duplicate payment reference"
 * where Paystack says "Duplicate transaction reference" and Flutterwave says
 * "reference is used already". Each provider matches its own strings rather than
 * sharing one list of substrings.
 */
function classifyMonnifyError(
  status: number,
  body: unknown,
): { error: typeof NaijaPayError; message?: string } | undefined {
  const bag = (body ?? {}) as Envelope;
  const message = typeof bag.responseMessage === "string" ? bag.responseMessage.toLowerCase() : "";

  if (message.includes("duplicate") || message.includes("already exist")) {
    return { error: DuplicateReferenceError };
  }
  if (message.includes("insufficient") || message.includes("balance is not enough")) {
    return { error: InsufficientFundsError };
  }
  if (message.includes("invalid credentials") || message.includes("unauthorized")) {
    return { error: AuthenticationError };
  }
  if (message.includes("bvn") || message.includes("nin") || message.includes("kyc")) {
    return { error: KycRequiredError };
  }
  // Monnify gates transfers, sub-accounts and refunds behind commercial approval, and
  // says so in prose. Reported as configuration, not authentication: the key is fine
  // and only Monnify can change it.
  if (
    message.includes("not enabled") ||
    message.includes("not activated") ||
    message.includes("contact") ||
    message.includes("not allowed to")
  ) {
    return {
      error: ConfigurationError,
      message:
        `monnify: ${bag.responseMessage} — this feature exists but is not enabled on ` +
        "your integration. Monnify gates transfers, sub-accounts and refunds behind " +
        "approval from your relationship manager; the API key is fine.",
    };
  }
  if (status === 404 || message.includes("not found") || message.includes("does not exist")) {
    return { error: NotFoundError };
  }
  if (status === 400 || status === 422) return { error: ValidationError };
  return undefined;
}

/** A sub-account's share of a collection, in our vocabulary rather than Monnify's. */
export interface MonnifySplitEntry {
  /** Monnify's `subAccountCode`. */
  readonly subAccountCode: string;
  /** This sub-account's share, in basis points. 2000 is 20%. */
  readonly shareBasisPoints?: number;
  /** A flat share instead of a percentage. Monnify allows either. */
  readonly shareAmount?: Money;
  /** The share of the Monnify fee this sub-account bears, in basis points. */
  readonly feeBasisPoints?: number;
  /** True when this sub-account bears the transaction fee. */
  readonly bearsFee?: boolean;
}

/** Monnify's own `incomeSplitConfig` entry, as its API spells it. */
interface MonnifyIncomeSplit {
  subAccountCode: string;
  splitPercentage?: number;
  splitAmount?: number;
  feePercentage?: number;
  feeBearer?: boolean;
}

/**
 * Basis points as the percentage Monnify wants.
 *
 * 2000 basis points is 20, which Monnify reads as 20%. Refused rather than rounded
 * when the conversion is not exact, because a rounded split moves somebody's money.
 */
function basisPointsToPercentage(basisPoints: number, field: string): number {
  if (!Number.isInteger(basisPoints) || basisPoints < 0 || basisPoints > 10_000) {
    throw new ValidationError(
      `monnify: ${field} must be whole basis points between 0 and 10000 (10000 is 100%), ` +
        `not ${basisPoints}.`,
      { provider: MONNIFY_PROVIDER_NAME },
    );
  }
  const percentage = basisPoints / 100;
  // Two decimal places is exactly what basis points express, so this only rejects a
  // genuine floating-point surprise.
  return Math.round(percentage * 100) / 100;
}

function toIncomeSplitConfig(entries: readonly MonnifySplitEntry[]): MonnifyIncomeSplit[] {
  return entries.map((entry) => {
    if (entry.shareBasisPoints === undefined && entry.shareAmount === undefined) {
      throw new ValidationError(
        `monnify: the split entry for ${entry.subAccountCode} needs either ` +
          "shareBasisPoints or shareAmount.",
        { provider: MONNIFY_PROVIDER_NAME },
      );
    }
    return {
      subAccountCode: entry.subAccountCode,
      ...(entry.shareBasisPoints === undefined
        ? {}
        : {
            splitPercentage: basisPointsToPercentage(entry.shareBasisPoints, "shareBasisPoints"),
          }),
      ...(entry.shareAmount === undefined ? {} : { splitAmount: toMajor(entry.shareAmount) }),
      ...(entry.feeBasisPoints === undefined
        ? {}
        : { feePercentage: basisPointsToPercentage(entry.feeBasisPoints, "feeBasisPoints") }),
      ...(entry.bearsFee === undefined ? {} : { feeBearer: entry.bearsFee }),
    };
  });
}

/** The cached Bearer token and when it stops being usable. */
interface CachedToken {
  readonly value: string;
  readonly expiresAtMs: number;
}

/**
 * How early a token is replaced.
 *
 * Monnify's token lifetime is NOT fixed. The documentation implies an hour, but the
 * sandbox issues `expiresIn: 828` — under fourteen minutes — so the value returned by
 * the login is the only one to trust, and `#performLogin` uses it. This margin is the
 * headroom on top of it: sixty seconds covers a slow request that starts while the token
 * is still valid and arrives after it is not.
 */
const TOKEN_REFRESH_MARGIN_MS = 60_000;

/**
 * Check the key pair and settle which environment this client is for.
 *
 * All of this is refusal rather than repair: a key pair that does not match the declared
 * environment is a deployment mistake, and the one that matters is live credentials in a
 * test deployment, so it throws rather than quietly switching hosts. Kept out of the
 * constructor so the constructor reads as wiring.
 */
function resolveMonnifyCredentials(options: MonnifyOptions): {
  readonly apiKey: string;
  readonly secretKey: string;
  readonly declared: "test" | "live";
} {
  const apiKey = options.apiKey?.trim();
  const secretKey = options.secretKey?.trim();

  if (!apiKey || !secretKey) {
    throw new ConfigurationError(
      "monnify: both apiKey and secretKey are required. Monnify authenticates with " +
        "the pair, as HTTP Basic, and exchanges them for a Bearer token.",
      { provider: MONNIFY_PROVIDER_NAME },
    );
  }
  if (!apiKey.startsWith("MK_")) {
    throw new ConfigurationError(
      "monnify: apiKey must begin MK_TEST_ or MK_PROD_. The secret key is the longer " +
        "value next to it on the dashboard, and the two are not interchangeable.",
      { provider: MONNIFY_PROVIDER_NAME },
    );
  }

  const declared = options.environment ?? (looksLikeLiveKey(apiKey) ? "live" : "test");

  if (declared === "test" && looksLikeLiveKey(apiKey)) {
    throw new ConfigurationError(
      "monnify: a LIVE api key (MK_PROD_) was supplied while environment is 'test'. " +
        "A live key cannot authenticate against the sandbox host, so this would fail " +
        "at Monnify — but it is refused here, because the mistake it usually " +
        "indicates is live credentials in a test deployment.",
      { provider: MONNIFY_PROVIDER_NAME },
    );
  }
  if (declared === "live" && looksLikeTestKey(apiKey)) {
    throw new ConfigurationError(
      "monnify: a TEST api key (MK_TEST_) was supplied while environment is 'live'.",
      { provider: MONNIFY_PROVIDER_NAME },
    );
  }
  if (declared === "live" && !isProductionEnvironment()) {
    (options.onLiveKeyWarning ?? defaultLiveKeyWarning)(
      "monnify: using a LIVE api key outside a production environment. Real money will move.",
    );
  }

  return { apiKey, secretKey, declared };
}

export class MonnifyProvider {
  readonly name = MONNIFY_PROVIDER_NAME;
  readonly capabilities = monnifyCapabilities;
  readonly notYetImplemented = NOT_YET_IMPLEMENTED;
  readonly #http: HttpClient;
  readonly #basic: string;
  readonly #secretKey: string;
  readonly #contractCode: string | undefined;
  readonly #walletAccountNumber: string | undefined;
  readonly #now: () => number;
  #token: CachedToken | undefined;
  /** In-flight login, so ten concurrent calls perform one login rather than ten. */
  #login: Promise<CachedToken> | undefined;

  constructor(options: MonnifyOptions) {
    const { apiKey, secretKey, declared } = resolveMonnifyCredentials(options);

    this.#secretKey = secretKey;
    this.#contractCode = options.contractCode?.trim() || undefined;
    this.#walletAccountNumber = options.walletAccountNumber?.trim() || undefined;
    this.#now = options.now ?? Date.now;
    // btoa is standard in every runtime this package supports, and Basic is base64 of
    // "key:secret" with no other encoding.
    this.#basic = btoa(`${apiKey}:${secretKey}`);

    this.#http = new HttpClient({
      provider: MONNIFY_PROVIDER_NAME,
      baseUrl: declared === "live" ? MONNIFY_LIVE_BASE_URL : MONNIFY_SANDBOX_BASE_URL,
      authorize: async () => ({ authorization: `Bearer ${(await this.#accessToken()).value}` }),
      classifyError: classifyMonnifyError,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.retry === undefined ? {} : { retry: options.retry }),
      ...(options.onLog === undefined ? {} : { onLog: options.onLog }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    });
  }

  // ------------------------------------------------------------- authentication

  /**
   * The current Bearer token, logging in when there is not one.
   *
   * Concurrent callers share one login: without that, an application that fires ten
   * requests on a cold client performs ten logins, and Monnify rate-limits the login
   * endpoint harder than anything else.
   */
  async #accessToken(): Promise<CachedToken> {
    const cached = this.#token;
    if (cached && cached.expiresAtMs > this.#now()) return cached;

    this.#login ??= this.#performLogin().finally(() => {
      this.#login = undefined;
    });
    return await this.#login;
  }

  /**
   * The login call itself.
   *
   * A 401 here is wrong credentials, not an expired token, so it is re-raised with a
   * message that says which pair to check rather than the HTTP client's generic one.
   */
  async #loginRequest() {
    try {
      return await this.#http.request<Envelope>({
        method: "POST",
        path: MONNIFY_LOGIN_PATH,
        operation: "auth.login",
        // A read of a token. Safe to repeat, and worth retrying: a failed login takes
        // every other call with it.
        safety: "safe",
        headers: { authorization: `Basic ${this.#basic}` },
        // The login carries Basic itself. Asking `authorize` for a Bearer here would
        // call straight back into the login.
        skipAuthorize: true,
      });
    } catch (error) {
      if (error instanceof AuthenticationError) {
        throw new AuthenticationError(
          `monnify: login failed — ${error.providerMessage || error.message}. ` +
            "Check the apiKey and secretKey pair, and that both are for this environment.",
          {
            provider: MONNIFY_PROVIDER_NAME,
            operation: "auth.login",
            ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
          },
        );
      }
      throw error;
    }
  }

  async #performLogin(): Promise<CachedToken> {
    const response = await this.#loginRequest();
    const envelope = response.body ?? {};
    const body = (envelope.responseBody ?? {}) as { accessToken?: string; expiresIn?: number };

    if (envelope.requestSuccessful === false || typeof body.accessToken !== "string") {
      throw new AuthenticationError(
        `monnify: login failed — ${envelope.responseMessage ?? "no access token was returned"}. ` +
          "Check the apiKey and secretKey pair, and that both are for this environment.",
        {
          provider: MONNIFY_PROVIDER_NAME,
          operation: "auth.login",
          httpStatus: response.status,
        },
      );
    }

    // Monnify documents expiresIn in seconds. A missing or absurd value falls back to
    // ten minutes rather than to never expiring, which would wedge the client.
    const seconds = typeof body.expiresIn === "number" && body.expiresIn > 0 ? body.expiresIn : 600;
    const token: CachedToken = {
      value: body.accessToken,
      expiresAtMs: this.#now() + seconds * 1_000 - TOKEN_REFRESH_MARGIN_MS,
    };
    this.#token = token;
    return token;
  }

  /**
   * Drop the cached token.
   *
   * Public because a long-lived process that has seen Monnify return 401 may want to
   * force a fresh login, and because the test suite uses it.
   */
  clearToken(): void {
    this.#token = undefined;
  }

  // ------------------------------------------------------------------ plumbing

  /**
   * Unwrap Monnify's `{requestSuccessful, responseMessage, responseCode, responseBody}`
   * envelope.
   *
   * A 200 carrying `requestSuccessful: false` is a real failure and must never be
   * returned as data. One retry on a 401 — and only on a 401, and only for a request
   * that is safe to repeat — covers a token that expired mid-flight.
   */
  async #call<T = unknown>(options: {
    method: "GET" | "POST" | "PUT" | "DELETE";
    path: string;
    operation: Operation;
    safety: "safe" | "unsafe" | "money-moving";
    body?: unknown;
    query?: Record<string, string | number | boolean | undefined>;
    reference?: string;
  }): Promise<{ data: T; message: string; responseCode: string }> {
    assertSupported(this.capabilities, options.operation);

    try {
      return await this.#send<T>(options);
    } catch (error) {
      const expired = error instanceof AuthenticationError && error.httpStatus === 401;
      if (!expired || options.safety !== "safe") throw error;
      // The token is the likeliest cause, and a second attempt with a fresh one is
      // cheap. Never done for a money-moving request: that is the whole point of the
      // safety taxonomy.
      this.clearToken();
      return await this.#send<T>(options);
    }
  }

  async #send<T>(options: {
    method: "GET" | "POST" | "PUT" | "DELETE";
    path: string;
    operation: Operation;
    safety: "safe" | "unsafe" | "money-moving";
    body?: unknown;
    query?: Record<string, string | number | boolean | undefined>;
    reference?: string;
  }): Promise<{ data: T; message: string; responseCode: string }> {
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
    const responseCode = envelope.responseCode === undefined ? "" : String(envelope.responseCode);

    if (envelope.requestSuccessful === false) {
      const classified = classifyMonnifyError(response.status, envelope);
      const ErrorClass = classified?.error ?? errorClassForStatus(response.status);
      throw new ErrorClass(
        classified?.message ?? envelope.responseMessage ?? "monnify reported a failure",
        {
          provider: MONNIFY_PROVIDER_NAME,
          operation: options.operation,
          httpStatus: response.status,
          ...(envelope.responseMessage === undefined
            ? {}
            : { providerMessage: envelope.responseMessage }),
          ...(responseCode === "" ? {} : { providerCode: responseCode }),
          ...(response.requestId === undefined ? {} : { requestId: response.requestId }),
        },
      );
    }

    // `/api/v1/transactions/search` is the one documented endpoint that returns its
    // payload — a Spring page — at the top level instead of inside `responseBody`.
    // Falling back to the whole body only when the envelope is absent entirely keeps a
    // genuine `responseBody: null` from being mistaken for an unwrapped payload.
    const unwrapped =
      envelope.responseBody === undefined && envelope.requestSuccessful === undefined
        ? (response.body as unknown)
        : envelope.responseBody;

    return {
      data: unwrapped as T,
      message: envelope.responseMessage ?? "",
      responseCode,
    };
  }

  #requireContractCode(operation: Operation): string {
    if (this.#contractCode === undefined) {
      throw new ConfigurationError(
        "monnify: contractCode is required for this call. It is on the dashboard under " +
          "your contract, and every collection endpoint needs it.",
        { provider: MONNIFY_PROVIDER_NAME, operation },
      );
    }
    return this.#contractCode;
  }

  #requireWalletAccountNumber(operation: Operation): string {
    if (this.#walletAccountNumber === undefined) {
      throw new ConfigurationError(
        "monnify: walletAccountNumber is required for this call. Monnify disburses from " +
          "a named wallet account and will not infer one, and the same number is needed " +
          "to read the balance.",
        { provider: MONNIFY_PROVIDER_NAME, operation },
      );
    }
    return this.#walletAccountNumber;
  }

  /** NGN only, and failing locally beats a Monnify rejection with no field named. */
  #assertNaira(amount: Money, operation: Operation): void {
    if (amount.currency !== "NGN") {
      throw new ValidationError(
        `monnify: ${amount.currency} is not supported. Monnify is a Nigerian acquirer ` +
          "and its documentation names no currency other than NGN.",
        { provider: MONNIFY_PROVIDER_NAME, operation },
      );
    }
  }

  // ----------------------------------------------------------------- collections

  /**
   * Create a hosted checkout and return its link.
   *
   * `paymentReference` is yours and must be unique; Monnify rejects a repeat with
   * "Duplicate payment reference", which arrives as `DuplicateReferenceError`.
   */
  async createCheckout(options: {
    readonly amount: Money;
    readonly email: string;
    readonly reference: string;
    readonly name?: string;
    readonly description?: string;
    readonly channels?: readonly Channel[];
    readonly callbackUrl?: string;
    readonly metadata?: Record<string, string | number | boolean>;
    readonly splits?: readonly MonnifySplitEntry[];
    /** Overrides the configured contract code, for a merchant with more than one. */
    readonly contractCode?: string;
  }): Promise<{
    readonly reference: string;
    readonly providerReference: string;
    readonly checkoutUrl: string;
    readonly enabledChannels: readonly Channel[];
    readonly provider: string;
    readonly raw: unknown;
  }> {
    this.#assertNaira(options.amount, "checkout.create");
    const contractCode = options.contractCode ?? this.#requireContractCode("checkout.create");
    const paymentMethods = this.#monnifyChannels(options.channels, "checkout.create");

    const { data } = await this.#call<{
      transactionReference?: string;
      checkoutUrl?: string;
      enabledPaymentMethod?: string[];
    }>({
      method: "POST",
      path: "/api/v1/merchant/transactions/init-transaction",
      operation: "checkout.create",
      // Keyed on paymentReference: a replay returns the same transaction rather than
      // creating a second one, so this is safe to retry.
      safety: "safe",
      body: {
        // Decimal major units, converted and round-trip-checked. Never amount.amount.
        amount: toMajor(options.amount),
        customerEmail: options.email,
        paymentReference: options.reference,
        currencyCode: options.amount.currency,
        contractCode,
        ...(options.name === undefined ? {} : { customerName: options.name }),
        ...(options.description === undefined ? {} : { paymentDescription: options.description }),
        ...(options.callbackUrl === undefined ? {} : { redirectUrl: options.callbackUrl }),
        ...(paymentMethods === undefined ? {} : { paymentMethods }),
        ...(options.splits === undefined || options.splits.length === 0
          ? {}
          : { incomeSplitConfig: toIncomeSplitConfig(options.splits) }),
        ...(options.metadata === undefined ? {} : { metaData: options.metadata }),
      },
    });

    const enabled = (data.enabledPaymentMethod ?? [])
      .map((method) => normaliseChannel(method))
      .filter((channel): channel is Channel => channel !== null);

    return {
      reference: options.reference,
      providerReference: data.transactionReference ?? "",
      checkoutUrl: data.checkoutUrl ?? "",
      enabledChannels: enabled,
      provider: MONNIFY_PROVIDER_NAME,
      raw: data,
    };
  }

  /** Our channel names as Monnify's, refusing the ones it does not have. */
  #monnifyChannels(
    channels: readonly Channel[] | undefined,
    operation: Operation,
  ): string[] | undefined {
    if (channels === undefined) return undefined;
    const unsupported = channels.filter((channel) => !CHANNEL_TO_MONNIFY[channel]);
    if (unsupported.length > 0) {
      throw new ValidationError(
        `monnify does not support the channel(s): ${unsupported.join(", ")}. ` +
          "See the capability matrix in PROVIDERS.md.",
        { provider: MONNIFY_PROVIDER_NAME, operation },
      );
    }
    return channels.map((channel) => CHANNEL_TO_MONNIFY[channel] as string);
  }

  /**
   * Verify a transaction by Monnify's own `transactionReference`.
   *
   * The reference contains pipes (`MNFY|67|20220725111957|000283`) and so must be
   * percent-encoded into the path. Monnify's own examples show it unencoded, which
   * works by luck rather than by design.
   */
  async verifyTransaction(transactionReference: string): Promise<Transaction> {
    const { data } = await this.#call({
      method: "GET",
      path: `/api/v2/transactions/${encodeURIComponent(transactionReference)}`,
      operation: "transactions.verify",
      safety: "safe",
    });
    return toTransaction(data);
  }

  /**
   * Verify a transaction by your own `paymentReference`.
   *
   * This is a separate endpoint — `/api/v2/merchant/transactions/query` — and not the
   * search route: it returns the same full transaction payload as `verifyTransaction`,
   * so a reference you generated is as good as Monnify's own. A reference Monnify has
   * never seen is a 404, which surfaces as `NotFoundError`.
   */
  async verifyTransactionByReference(paymentReference: string): Promise<Transaction> {
    const { data } = await this.#call({
      method: "GET",
      path: "/api/v2/merchant/transactions/query",
      operation: "transactions.verify",
      safety: "safe",
      query: { paymentReference },
    });
    if (data === undefined || data === null) {
      throw new NotFoundError(
        `monnify: no transaction matches the payment reference "${paymentReference}".`,
        { provider: MONNIFY_PROVIDER_NAME, operation: "transactions.verify" },
      );
    }
    return toTransaction(data);
  }

  /** List transactions. Monnify pages from zero, which `toPage` keeps as-is. */
  async listTransactions(
    options: {
      readonly page?: number;
      readonly pageSize?: number;
      readonly paymentReference?: string;
    } = {},
  ): Promise<Page<Transaction>> {
    const { data } = await this.#call({
      method: "GET",
      path: "/api/v1/transactions/search",
      operation: "transactions.list",
      safety: "safe",
      query: {
        ...(options.page === undefined ? {} : { page: options.page }),
        ...(options.pageSize === undefined ? {} : { size: options.pageSize }),
        ...(options.paymentReference === undefined
          ? {}
          : { paymentReference: options.paymentReference }),
      },
    });
    // This endpoint returns the Spring page at the top level rather than inside
    // responseBody, which is the one place Monnify breaks its own envelope.
    return toPage(data, toTransaction);
  }

  // --------------------------------------------------------------------- refunds

  /**
   * Initiate a refund.
   *
   * Needs Monnify's approval in live mode. `refundReason` and `customerNote` are both
   * required by the API; the note is shown to the customer.
   */
  async createRefund(options: {
    readonly transactionReference: string;
    readonly amount: Money;
    readonly reference: string;
    readonly reason: string;
    readonly customerNote: string;
    readonly destinationAccountNumber?: string;
    readonly destinationBankCode?: string;
  }): Promise<Refund> {
    this.#assertNaira(options.amount, "refunds.create");
    const { data } = await this.#call({
      method: "POST",
      path: "/api/v1/refunds/initiate-refund",
      operation: "refunds.create",
      // Moves money back to a customer. Never retried.
      safety: "money-moving",
      reference: options.reference,
      body: {
        transactionReference: options.transactionReference,
        refundAmount: toMajor(options.amount),
        refundReference: options.reference,
        refundReason: options.reason,
        customerNote: options.customerNote,
        ...(options.destinationAccountNumber === undefined
          ? {}
          : { destinationAccountNumber: options.destinationAccountNumber }),
        ...(options.destinationBankCode === undefined
          ? {}
          : { destinationAccountBankCode: options.destinationBankCode }),
      },
    });
    return toRefund(data);
  }

  /**
   * One refund's status, by your own refund reference.
   *
   * The path is `/api/v1/refunds/{refundReference}`. Monnify's OpenAPI document spells
   * that path key with a literal example value in it — `/api/v1/refunds/202100op3456`
   * — and only the `refundReference` path parameter underneath reveals what it really
   * is. Copying the key would 404 on every refund but one. See PROVIDERS.md.
   */
  async getRefund(refundReference: string): Promise<Refund> {
    const { data } = await this.#call({
      method: "GET",
      path: `/api/v1/refunds/${encodeURIComponent(refundReference)}`,
      operation: "refunds.status",
      safety: "safe",
    });
    return toRefund(data);
  }

  async listRefunds(
    options: { readonly page?: number; readonly pageSize?: number } = {},
  ): Promise<Page<Refund>> {
    const { data } = await this.#call({
      method: "GET",
      path: "/api/v1/refunds",
      operation: "refunds.status",
      safety: "safe",
      query: {
        ...(options.page === undefined ? {} : { page: options.page }),
        ...(options.pageSize === undefined ? {} : { size: options.pageSize }),
      },
    });
    return toPage(data, toRefund);
  }

  // ------------------------------------------------------------ virtual accounts

  /**
   * Reserve a virtual account for a customer.
   *
   * Two Monnify behaviours worth knowing before you call this:
   *
   * - `allBanks: true` reserves an account at **every** partner bank at once and
   *   returns them all. No other Tier 1 provider does this, and it is the reason
   *   `accounts` is a list.
   * - `restrictPaymentSource` decides whether the account accepts inflows only from
   *   named sources. Monnify's documentation says it defaults to **true**; the sandbox
   *   returns **false** when the field is omitted (verified 2026-11-19). Rather than
   *   depend on either, this adapter always sends the field: `false` unless you pass
   *   `allowedSources`, so an account you create is usable by default. Pass
   *   `allowedSources` to get Monnify's own restriction, which is a genuinely useful
   *   control where you know who should be paying.
   */
  async createVirtualAccount(options: {
    readonly reference: string;
    readonly accountName: string;
    readonly customerEmail: string;
    readonly customerName: string;
    readonly bvn?: string;
    readonly nin?: string;
    readonly allBanks?: boolean;
    readonly preferredBankCodes?: readonly string[];
    readonly splits?: readonly MonnifySplitEntry[];
    readonly allowedSources?: {
      readonly bvns?: readonly string[];
      readonly accountNames?: readonly string[];
      readonly bankAccounts?: readonly {
        readonly accountNumber: string;
        readonly bankCode: string;
      }[];
    };
    readonly contractCode?: string;
  }): Promise<VirtualAccount> {
    const contractCode =
      options.contractCode ?? this.#requireContractCode("virtualAccounts.createStatic");

    if (options.bvn === undefined && options.nin === undefined) {
      throw new KycRequiredError(
        "monnify: a reserved account needs a bvn (the spec marks it required) or, where " +
          "your integration is configured for it, a nin. Neither was supplied.",
        {
          provider: MONNIFY_PROVIDER_NAME,
          operation: "virtualAccounts.createStatic",
          required: ["bvn"],
        },
      );
    }

    const allBanks = options.allBanks ?? options.preferredBankCodes === undefined;
    if (!allBanks && (options.preferredBankCodes ?? []).length === 0) {
      throw new ValidationError(
        "monnify: either set allBanks, or name at least one preferredBankCodes entry. " +
          "Monnify requires one or the other and rejects a request with neither.",
        { provider: MONNIFY_PROVIDER_NAME, operation: "virtualAccounts.createStatic" },
      );
    }

    const { data } = await this.#call({
      method: "POST",
      path: "/api/v2/bank-transfer/reserved-accounts",
      operation: "virtualAccounts.createStatic",
      // Keyed on accountReference. A replay returns the existing reservation.
      safety: "safe",
      body: {
        accountReference: options.reference,
        accountName: options.accountName,
        currencyCode: "NGN",
        contractCode,
        customerEmail: options.customerEmail,
        customerName: options.customerName,
        ...(options.bvn === undefined ? {} : { bvn: options.bvn }),
        ...(options.nin === undefined ? {} : { nin: options.nin }),
        getAllAvailableBanks: allBanks,
        ...(allBanks ? {} : { preferredBanks: options.preferredBankCodes }),
        ...(options.splits === undefined || options.splits.length === 0
          ? {}
          : { incomeSplitConfig: toIncomeSplitConfig(options.splits) }),
        // Explicitly false rather than omitted: Monnify's own default is true.
        restrictPaymentSource: options.allowedSources !== undefined,
        ...(options.allowedSources === undefined
          ? {}
          : {
              allowedPaymentSources: {
                ...(options.allowedSources.bvns === undefined
                  ? {}
                  : { bvns: options.allowedSources.bvns }),
                ...(options.allowedSources.accountNames === undefined
                  ? {}
                  : { accountNames: options.allowedSources.accountNames }),
                ...(options.allowedSources.bankAccounts === undefined
                  ? {}
                  : { bankAccounts: options.allowedSources.bankAccounts }),
              },
            }),
      },
    });

    return toVirtualAccount(data, { reference: options.reference, kind: "static" });
  }

  async getVirtualAccount(reference: string): Promise<VirtualAccount> {
    const { data } = await this.#call({
      method: "GET",
      path: `/api/v2/bank-transfer/reserved-accounts/${encodeURIComponent(reference)}`,
      operation: "virtualAccounts.get",
      safety: "safe",
    });
    return toVirtualAccount(data, { reference, kind: "static" });
  }

  /**
   * Update the BVN on a reserved account.
   *
   * Monnify has two KYC routes and they are not interchangeable: this one takes a BVN
   * alone, and `updateVirtualAccountKyc` requires both a BVN and a NIN. Note also that
   * this route's path parameter is named `reservedAccountReference` while every
   * neighbouring route calls the same value `accountReference`.
   */
  async updateVirtualAccountBvn(options: {
    readonly reference: string;
    readonly bvn: string;
  }): Promise<VirtualAccount> {
    const { data } = await this.#call({
      method: "PUT",
      path:
        "/api/v1/bank-transfer/reserved-accounts/update-customer-bvn/" +
        encodeURIComponent(options.reference),
      operation: "virtualAccounts.updateKyc",
      safety: "safe",
      body: { bvn: options.bvn },
    });
    return toVirtualAccount(data, { reference: options.reference, kind: "static" });
  }

  /**
   * Attach both a BVN and a NIN to a reserved account.
   *
   * Monnify's spec marks **both** fields required on this route, so a caller with only
   * one of them is told locally to use `updateVirtualAccountBvn` instead of receiving
   * a rejection that does not name the field.
   */
  async updateVirtualAccountKyc(options: {
    readonly reference: string;
    readonly bvn: string;
    readonly nin: string;
  }): Promise<VirtualAccount> {
    if (!options.bvn || !options.nin) {
      throw new ValidationError(
        "monnify: the kyc-info route requires BOTH a bvn and a nin. To set a BVN alone, " +
          "use updateVirtualAccountBvn, which is a different endpoint.",
        { provider: MONNIFY_PROVIDER_NAME, operation: "virtualAccounts.updateKyc" },
      );
    }
    const { data } = await this.#call({
      method: "PUT",
      path:
        `/api/v1/bank-transfer/reserved-accounts/${encodeURIComponent(options.reference)}` +
        "/kyc-info",
      operation: "virtualAccounts.updateKyc",
      safety: "safe",
      body: { bvn: options.bvn, nin: options.nin },
    });
    return toVirtualAccount(data, { reference: options.reference, kind: "static" });
  }

  /**
   * Replace a reserved account's income split configuration.
   *
   * The request body is a bare **array**, not an object — the one endpoint in the
   * Monnify API where that is true.
   */
  async updateVirtualAccountSplits(options: {
    readonly reference: string;
    readonly splits: readonly MonnifySplitEntry[];
  }): Promise<unknown> {
    const { data } = await this.#call({
      method: "PUT",
      path:
        "/api/v1/bank-transfer/reserved-accounts/update-income-split-config/" +
        encodeURIComponent(options.reference),
      operation: "splits.update",
      safety: "safe",
      body: toIncomeSplitConfig(options.splits),
    });
    return data;
  }

  /**
   * Deallocate a reserved account.
   *
   * Monnify's word is deallocation and there is no route to undo it, so the account
   * number is gone for good. Flutterwave, by contrast, deactivates and reactivates one
   * account; this is why `virtualAccounts.deactivate` is where Monnify's support ends.
   */
  async deactivateVirtualAccount(reference: string): Promise<VirtualAccount> {
    const { data } = await this.#call({
      method: "DELETE",
      path: `/api/v1/bank-transfer/reserved-accounts/reference/${encodeURIComponent(reference)}`,
      operation: "virtualAccounts.deactivate",
      // Not money-moving, but it destroys state and is not keyed by anything we own, so
      // it is never retried.
      safety: "unsafe",
      reference,
    });
    return toVirtualAccount(data, { reference, kind: "static" });
  }

  /** Inflows to one reserved account. `accountReference` is required by Monnify. */
  async listVirtualAccountInflows(options: {
    readonly reference: string;
    readonly page?: number;
    readonly pageSize?: number;
  }): Promise<Page<Transaction>> {
    const { data } = await this.#call({
      method: "GET",
      path: "/api/v1/bank-transfer/reserved-accounts/transactions",
      operation: "virtualAccounts.listInflows",
      safety: "safe",
      query: {
        accountReference: options.reference,
        ...(options.page === undefined ? {} : { page: options.page }),
        ...(options.pageSize === undefined ? {} : { size: options.pageSize }),
      },
    });
    return toPage(data, toTransaction);
  }

  // ------------------------------------------------------------- split accounts

  /**
   * Create one or more settlement sub-accounts.
   *
   * Monnify takes an array here and returns an array, even for a single sub-account,
   * which is why this method is plural. Needs Monnify's approval in live mode.
   */
  async createSplitAccounts(
    accounts: readonly {
      readonly accountNumber: string;
      readonly bankCode: string;
      readonly email: string;
      readonly defaultShareBasisPoints: number;
      readonly currencyCode?: string;
    }[],
  ): Promise<readonly SplitAccount[]> {
    if (accounts.length === 0) {
      throw new ValidationError("monnify: createSplitAccounts needs at least one account.", {
        provider: MONNIFY_PROVIDER_NAME,
        operation: "splitAccounts.create",
      });
    }

    const { data } = await this.#call<unknown[]>({
      method: "POST",
      path: "/api/v1/sub-accounts",
      operation: "splitAccounts.create",
      // Creates state with no reference of ours to key on, so a repeat would make a
      // second sub-account.
      safety: "unsafe",
      body: accounts.map((account) => ({
        currencyCode: account.currencyCode ?? "NGN",
        accountNumber: account.accountNumber,
        bankCode: account.bankCode,
        email: account.email,
        defaultSplitPercentage: basisPointsToPercentage(
          account.defaultShareBasisPoints,
          "defaultShareBasisPoints",
        ),
      })),
    });

    return (Array.isArray(data) ? data : []).map(toSplitAccount);
  }

  async listSplitAccounts(): Promise<readonly SplitAccount[]> {
    const { data } = await this.#call<unknown[]>({
      method: "GET",
      path: "/api/v1/sub-accounts",
      operation: "splitAccounts.list",
      safety: "safe",
    });
    return (Array.isArray(data) ? data : []).map(toSplitAccount);
  }

  /** Update a sub-account. `subAccountCode` goes in the body, not the path. */
  async updateSplitAccount(options: {
    readonly subAccountCode: string;
    readonly accountNumber: string;
    readonly bankCode: string;
    readonly email: string;
    readonly defaultShareBasisPoints: number;
    readonly currencyCode?: string;
  }): Promise<SplitAccount> {
    const { data } = await this.#call({
      method: "PUT",
      path: "/api/v1/sub-accounts",
      operation: "splitAccounts.update",
      safety: "safe",
      body: {
        subAccountCode: options.subAccountCode,
        currencyCode: options.currencyCode ?? "NGN",
        accountNumber: options.accountNumber,
        bankCode: options.bankCode,
        email: options.email,
        defaultSplitPercentage: basisPointsToPercentage(
          options.defaultShareBasisPoints,
          "defaultShareBasisPoints",
        ),
      },
    });
    return toSplitAccount(data);
  }

  async deleteSplitAccount(subAccountCode: string): Promise<void> {
    await this.#call({
      method: "DELETE",
      path: `/api/v1/sub-accounts/${encodeURIComponent(subAccountCode)}`,
      operation: "splitAccounts.deactivate",
      safety: "unsafe",
      reference: subAccountCode,
    });
  }

  /**
   * A reusable split declaration.
   *
   * Monnify has no split object to create, so this makes no network call: it validates
   * the shares and returns the entries to hand to `createCheckout` or
   * `createVirtualAccount`. Same shape as the Flutterwave adapter's `createSplit`, for
   * the same reason.
   */
  createSplit(entries: readonly MonnifySplitEntry[]): readonly MonnifySplitEntry[] {
    assertSupported(this.capabilities, "splits.create");
    // Converted and thrown away, purely so an invalid share fails here rather than on
    // the checkout call that uses it days later.
    toIncomeSplitConfig(entries);
    return entries;
  }

  // --------------------------------------------------------------------- payouts

  /**
   * Create a single transfer.
   *
   * **This usually does not move money yet.** Monnify enables two-factor disbursement
   * by default, and a new transfer then comes back with status
   * `PENDING_AUTHORIZATION`: an OTP goes to the registered email, and nothing happens
   * until `authorizePayout` submits it. The returned payout carries `awaitingOtp` so a
   * caller can act on that rather than waiting for a webhook that will never arrive.
   *
   * Never retried, whatever the transport does. A duplicate transfer is the most
   * expensive bug this SDK could have, so a timeout raises
   * `PayoutStatusUnknownError` naming your reference to query.
   */
  async createPayout(options: {
    readonly amount: Money;
    readonly reference: string;
    readonly narration: string;
    readonly bankCode: string;
    readonly accountNumber: string;
    readonly accountName: string;
    /** Overrides the configured wallet account number. */
    readonly sourceAccountNumber?: string;
    readonly async?: boolean;
  }): Promise<Payout> {
    this.#assertNaira(options.amount, "payouts.create");
    const source =
      options.sourceAccountNumber ?? this.#requireWalletAccountNumber("payouts.create");

    const { data } = await this.#call({
      method: "POST",
      path: "/api/v2/disbursements/single",
      operation: "payouts.create",
      safety: "money-moving",
      reference: options.reference,
      body: {
        amount: toMajor(options.amount),
        reference: options.reference,
        narration: options.narration,
        destinationBankCode: options.bankCode,
        destinationAccountNumber: options.accountNumber,
        destinationAccountName: options.accountName,
        currency: options.amount.currency,
        sourceAccountNumber: source,
        ...(options.async === undefined ? {} : { async: options.async }),
      },
    });
    return toPayout(data);
  }

  /**
   * Submit the OTP for a single transfer.
   *
   * The second half of `createPayout` whenever two-factor is on. Money-moving: this is
   * the call that actually releases the funds.
   */
  async authorizePayout(options: {
    readonly reference: string;
    readonly otp: string;
  }): Promise<Payout> {
    const { data } = await this.#call({
      method: "POST",
      path: "/api/v2/disbursements/single/validate-otp",
      operation: "payouts.create",
      safety: "money-moving",
      reference: options.reference,
      body: { reference: options.reference, authorizationCode: options.otp },
    });
    return toPayout(data);
  }

  /** Ask Monnify to send a fresh OTP for a transfer awaiting authorisation. */
  async resendPayoutOtp(reference: string): Promise<string> {
    const { data, message } = await this.#call<{ message?: string }>({
      method: "POST",
      path: "/api/v2/disbursements/single/resend-otp",
      operation: "payouts.create",
      // Sends an email. Nothing moves, and a repeat is harmless.
      safety: "safe",
      body: { reference },
    });
    return data?.message ?? message;
  }

  /** One transfer's status, by your own reference. */
  async getPayout(reference: string): Promise<Payout> {
    const { data } = await this.#call({
      method: "GET",
      path: "/api/v2/disbursements/single/summary",
      operation: "payouts.status",
      safety: "safe",
      query: { reference },
    });
    return toPayout(data);
  }

  async listPayouts(
    options: { readonly page?: number; readonly pageSize?: number } = {},
  ): Promise<Page<Payout>> {
    const { data } = await this.#call({
      method: "GET",
      path: "/api/v2/disbursements/single/transactions",
      operation: "payouts.status",
      safety: "safe",
      query: {
        // This endpoint spells its paging parameters pageNo and pageSize, where the
        // transaction search uses page and size. Monnify is not consistent, and
        // guessing wrong silently returns the first page every time.
        ...(options.page === undefined ? {} : { pageNo: options.page }),
        ...(options.pageSize === undefined ? {} : { pageSize: options.pageSize }),
      },
    });
    return toPage(data, toPayout);
  }

  /**
   * Create a batch of transfers.
   *
   * `onValidationFailure` decides what happens to a batch containing one bad row:
   * `BREAK` abandons the whole batch, `CONTINUE` skips the row. Defaulted to `BREAK`,
   * because the safe default for money is to do nothing until a human looks.
   */
  async createBulkPayout(options: {
    readonly batchReference: string;
    readonly narration: string;
    readonly transfers: readonly {
      readonly amount: Money;
      readonly reference: string;
      readonly narration: string;
      readonly bankCode: string;
      readonly accountNumber: string;
      readonly accountName?: string;
    }[];
    readonly sourceAccountNumber?: string;
    readonly onValidationFailure?: "BREAK" | "CONTINUE";
    readonly notificationInterval?: number;
  }): Promise<BulkPayout> {
    if (options.transfers.length === 0) {
      throw new ValidationError("monnify: a bulk payout needs at least one transfer.", {
        provider: MONNIFY_PROVIDER_NAME,
        operation: "payouts.createBulk",
      });
    }
    for (const transfer of options.transfers)
      this.#assertNaira(transfer.amount, "payouts.createBulk");
    const source =
      options.sourceAccountNumber ?? this.#requireWalletAccountNumber("payouts.createBulk");

    const { data } = await this.#call({
      method: "POST",
      path: "/api/v2/disbursements/batch",
      operation: "payouts.createBulk",
      safety: "money-moving",
      reference: options.batchReference,
      body: {
        title: options.narration,
        batchReference: options.batchReference,
        narration: options.narration,
        sourceAccountNumber: source,
        onValidationFailure: options.onValidationFailure ?? "BREAK",
        notificationInterval: options.notificationInterval ?? 10,
        transactionList: options.transfers.map((transfer) => ({
          amount: toMajor(transfer.amount),
          reference: transfer.reference,
          narration: transfer.narration,
          destinationBankCode: transfer.bankCode,
          destinationAccountNumber: transfer.accountNumber,
          currency: transfer.amount.currency,
          ...(transfer.accountName === undefined
            ? {}
            : { destinationAccountName: transfer.accountName }),
        })),
      },
    });
    return toBulkPayout(data);
  }

  /** Submit the OTP for a batch. The field is `reference`, not `batchReference`. */
  async authorizeBulkPayout(options: {
    readonly batchReference: string;
    readonly otp: string;
  }): Promise<BulkPayout> {
    const { data } = await this.#call({
      method: "POST",
      path: "/api/v2/disbursements/batch/validate-otp",
      operation: "payouts.createBulk",
      safety: "money-moving",
      reference: options.batchReference,
      body: { reference: options.batchReference, authorizationCode: options.otp },
    });
    return toBulkPayout(data);
  }

  /** A batch's summary, including per-status counts and amounts. */
  async getBulkPayout(batchReference: string): Promise<BulkPayout> {
    const { data } = await this.#call({
      method: "GET",
      path: "/api/v2/disbursements/batch/summary",
      operation: "payouts.status",
      safety: "safe",
      // This endpoint takes the batch reference as `reference`.
      query: { reference: batchReference },
    });
    return toBulkPayout(data);
  }

  // ----------------------------------------------------------- banks and balance

  /** Every bank Monnify can pay, with its USSD templates. */
  async listBanks(): Promise<readonly Bank[]> {
    const { data } = await this.#call<unknown[]>({
      method: "GET",
      path: "/api/v1/banks",
      operation: "banks.list",
      safety: "safe",
    });
    return (Array.isArray(data) ? data : []).map(toBank);
  }

  /**
   * Resolve an account number to its holder's name.
   *
   * Monnify echoes the bank code back, which Flutterwave does not, so no carrying
   * through is needed here.
   */
  async resolveAccount(options: {
    readonly accountNumber: string;
    readonly bankCode: string;
  }): Promise<BankAccount> {
    const { data } = await this.#call<{
      accountNumber?: string;
      accountName?: string;
      bankCode?: string;
    }>({
      method: "GET",
      path: "/api/v2/disbursements/account/validate",
      operation: "banks.resolveAccount",
      safety: "safe",
      query: { accountNumber: options.accountNumber, bankCode: options.bankCode },
    });

    return enrich({
      accountNumber: data.accountNumber ?? options.accountNumber,
      accountName: data.accountName ?? "",
      bankCode: data.bankCode ?? options.bankCode,
    });
  }

  /** Your wallet balance, as integer minor units. */
  async getBalance(accountNumber?: string): Promise<Balance> {
    const account = accountNumber ?? this.#requireWalletAccountNumber("balance.get");
    const { data } = await this.#call({
      method: "GET",
      path: "/api/v2/disbursements/wallet-balance",
      operation: "balance.get",
      safety: "safe",
      query: { accountNumber: account },
    });
    return toBalance(data, account);
  }

  // -------------------------------------------------------------------- webhooks

  /**
   * Verify a webhook from Monnify.
   *
   * `body` must be the raw bytes exactly as received. Parsing or re-serialising first
   * guarantees a mismatch, and it is the commonest cause of "my signature does not
   * verify".
   *
   * HMAC-SHA512 hex over the raw body, keyed with your **secret key** — Monnify calls
   * it the client secret, and it is the same value used to authenticate, not a separate
   * webhook key.
   *
   * **In sandbox there is nothing to verify.** Monnify's documentation says the
   * `monnify-signature` header is only included on production notifications, so a
   * sandbox delivery returns `verified: false` with that as the reason. That is the
   * honest answer, and it is why this adapter also offers `isKnownWebhookIp`.
   */
  async verifyWebhook(options: {
    readonly body: Uint8Array;
    readonly headers: Readonly<Record<string, string>>;
  }): Promise<VerificationResult> {
    assertSupported(this.capabilities, "webhooks.verify");

    const headers = lowercaseKeys(options.headers);
    if (headers["monnify-signature"] === undefined) {
      return {
        verified: false,
        strength: "unverified",
        reason:
          'the "monnify-signature" header is missing. Monnify documents that this ' +
          "header is only sent on production notifications and is absent in sandbox, " +
          "so a sandbox delivery can never be verified — check the source IP against " +
          "isKnownWebhookIp and re-verify the transaction with the API before giving " +
          "value.",
      };
    }

    return await verifySignature({
      scheme: SCHEMES.monnify,
      body: options.body,
      headers,
      secret: this.#secretKey,
    });
  }

  /**
   * Is this the address Monnify sends webhooks from?
   *
   * Monnify publishes one: `35.242.133.146`. A second line of defence, never a
   * replacement for the signature — an IP is trivially spoofed if anything between
   * Monnify and your handler is willing to forward a header.
   */
  isKnownWebhookIp(ip: string): boolean {
    return MONNIFY_WEBHOOK_IPS.includes(ip.trim());
  }
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

/** Create a Monnify provider. */
export function monnify(options: MonnifyOptions): MonnifyProvider {
  return new MonnifyProvider(options);
}
