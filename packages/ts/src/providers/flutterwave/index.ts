/**
 * The Flutterwave adapter.
 *
 * Read from Flutterwave's current documentation on 2026-11-02. Not yet
 * sandbox-verified; see PROVIDERS.md for the status table.
 *
 * Why this talks to v3 rather than v4 is explained in `capabilities.ts`. Five
 * Flutterwave-specific traps this adapter absorbs, each from the docs:
 *
 * 1. **Decimals on the wire.** Every amount Flutterwave sends or accepts is a decimal
 *    in major units — `5000` means five thousand naira, and a balance comes back as
 *    `20000.5`. naija-pay is integer minor units throughout, so conversion happens at
 *    this boundary and nowhere else, through `toMajor`/`fromMajor`, which assert the
 *    round trip instead of multiplying by 100 and hoping.
 * 2. **"Transfer Queued Successfully" is not a completed transfer.** A created payout
 *    comes back with the envelope saying `"status": "success"` and `data.status` saying
 *    `"NEW"`. It is queued. Reading the envelope would mark every payout as paid the
 *    moment Flutterwave accepted it; we read `data.status` and report `pending`.
 * 3. **A 200 can be a failure.** v3 signals errors with `"status": "error"` inside a
 *    200 response as well as with HTTP statuses, so the envelope is always checked.
 * 4. **Percentage splits are decimal fractions.** Flutterwave's own docs say a 9%
 *    commission is `0.09`. Our API is basis points, so 900 becomes 0.09 here.
 * 5. **Two webhook schemes, one weak.** v3's `verif-hash` is the secret itself and
 *    proves nothing about the payload. `verifyWebhook` reports which scheme it used
 *    and how strong it was, so an application can refuse the weak one.
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
import { basisPointsToFraction, type Money, toMajor } from "../../core/money.ts";
import { looksLikeLiveKey, looksLikeTestKey } from "../../core/redact.ts";
import { SCHEMES, type VerificationResult, verifySignature } from "../../core/signatures.ts";
import {
  CHANNEL_TO_FLUTTERWAVE,
  FLUTTERWAVE_BASE_URL,
  FLUTTERWAVE_PROVIDER_NAME,
  flutterwaveCapabilities,
} from "./capabilities.ts";
import {
  type BankAccount,
  enrich,
  type Payout,
  type Refund,
  type SplitAccount,
  type Transaction,
  toPayout,
  toRefund,
  toSplitAccount,
  toTransaction,
  toVirtualAccount,
  toWalletAccount,
  toWalletBalance,
  type VirtualAccount,
  type WalletAccount,
  type WalletBalance,
} from "./normalise.ts";

export * from "./capabilities.ts";
export * from "./normalise.ts";

export interface FlutterwaveOptions {
  /** The v3 secret key: `FLWSECK_TEST-…` for test, `FLWSECK-…` for live. */
  readonly secretKey: string;
  /**
   * The secret hash set under Settings > Webhooks on the dashboard.
   *
   * Separate from the secret key, and required for `verifyWebhook`: Flutterwave keys
   * webhooks on a value you choose, not on the API key. Paystack reuses the secret
   * key, so this option has no Paystack equivalent.
   */
  readonly webhookSecretHash?: string;
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

/**
 * Flutterwave's reference rules.
 *
 * v3 does not publish a pattern for `tx_ref`, but v4 does — 6 to 42 characters of
 * letters, digits and hyphens — and a reference that v4 would reject is a reference
 * that cannot be carried forward when v4 arrives. We enforce the stricter rule now,
 * with a message that says why, rather than accepting something that will break later.
 */
const REFERENCE = /^[A-Za-z0-9-]{6,42}$/;

interface Envelope {
  status?: string;
  message?: string;
  data?: unknown;
  meta?: unknown;
}

/**
 * Flutterwave's error wording, mapped onto our typed errors.
 *
 * Matched on Flutterwave's own documented phrasing, which differs from Paystack's for
 * the same condition: Flutterwave says "Insufficient funds" where Paystack says "Your
 * balance is not enough to fulfil this request". That difference was found by running
 * against Paystack's sandbox, and it is why each provider matches its own wording
 * rather than sharing one list of substrings.
 */
function classifyFlutterwaveError(
  status: number,
  body: unknown,
): { error: typeof NaijaPayError; message?: string } | undefined {
  const bag = (body ?? {}) as Envelope;
  const message = typeof bag.message === "string" ? bag.message.toLowerCase() : "";

  if (message.includes("reference is used already") || message.includes("duplicate")) {
    return { error: DuplicateReferenceError };
  }
  if (message.includes("insufficient")) {
    return { error: InsufficientFundsError };
  }
  // Flutterwave gates several features per merchant, and says so in prose rather than
  // with a distinct code. Reported as configuration, not authentication, because the
  // key is fine and only support can change it.
  if (
    message.includes("not enabled") ||
    message.includes("not activated") ||
    message.includes("kindly contact") ||
    message.includes("contact support")
  ) {
    return {
      error: ConfigurationError,
      message:
        `flutterwave: ${bag.message} — this feature exists but is not enabled on your ` +
        "account. Ask Flutterwave support to enable it; the API key is fine.",
    };
  }
  if (message.includes("bvn") || message.includes("nin") || message.includes("kyc")) {
    return { error: KycRequiredError };
  }
  if (status === 404 || message.includes("no transaction") || message.includes("not found")) {
    return { error: NotFoundError };
  }
  if (status === 400 || status === 422) return { error: ValidationError };
  return undefined;
}

export class FlutterwaveProvider {
  readonly name = FLUTTERWAVE_PROVIDER_NAME;
  readonly capabilities = flutterwaveCapabilities;
  readonly #http: HttpClient;
  readonly #webhookSecretHash: string | undefined;

  constructor(options: FlutterwaveOptions) {
    const key = options.secretKey?.trim();
    if (!key) {
      throw new ConfigurationError("flutterwave: secretKey is required", {
        provider: FLUTTERWAVE_PROVIDER_NAME,
      });
    }
    if (!key.startsWith("FLWSECK")) {
      throw new ConfigurationError(
        "flutterwave: secretKey must be a v3 secret key beginning FLWSECK_TEST- or " +
          "FLWSECK-. A public key (FLWPUBK) cannot authorise server-side calls, and a " +
          "v4 OAuth client secret is not a v3 key — this adapter speaks v3, for the " +
          "reasons in PROVIDERS.md.",
        { provider: FLUTTERWAVE_PROVIDER_NAME },
      );
    }

    const declared = options.environment ?? (looksLikeLiveKey(key) ? "live" : "test");

    // The check that matters, because v3 serves test and live from one host.
    if (declared === "test" && looksLikeLiveKey(key)) {
      throw new ConfigurationError(
        "flutterwave: a LIVE secret key was supplied while environment is 'test'. " +
          "v3 serves test and live from the same host, so this would move real money. " +
          "Use a FLWSECK_TEST- key, or set environment to 'live' deliberately.",
        { provider: FLUTTERWAVE_PROVIDER_NAME },
      );
    }
    if (declared === "live" && looksLikeTestKey(key)) {
      throw new ConfigurationError(
        "flutterwave: a TEST secret key was supplied while environment is 'live'.",
        { provider: FLUTTERWAVE_PROVIDER_NAME },
      );
    }

    if (declared === "live" && !isProductionEnvironment()) {
      const warning =
        "flutterwave: using a LIVE key outside a production environment. Real money will move.";
      (options.onLiveKeyWarning ?? defaultLiveKeyWarning)(warning);
    }

    this.#webhookSecretHash = options.webhookSecretHash?.trim() || undefined;
    this.#http = new HttpClient({
      provider: FLUTTERWAVE_PROVIDER_NAME,
      baseUrl: FLUTTERWAVE_BASE_URL,
      headers: { authorization: `Bearer ${key}` },
      classifyError: classifyFlutterwaveError,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.retry === undefined ? {} : { retry: options.retry }),
      ...(options.onLog === undefined ? {} : { onLog: options.onLog }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    });
  }

  /**
   * Unwrap Flutterwave's `{status, message, data}` envelope.
   *
   * `status` is a string here, not Paystack's boolean: `"success"` or `"error"`. A
   * 200 carrying `"status": "error"` is a real failure and must not be returned as
   * data — Flutterwave uses that combination for duplicate references among others.
   */
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
    const status = typeof envelope.status === "string" ? envelope.status.toLowerCase() : "";
    if (status !== "" && status !== "success") {
      const classified = classifyFlutterwaveError(response.status, envelope);
      const ErrorClass = classified?.error ?? errorClassForStatus(response.status);
      throw new ErrorClass(
        classified?.message ?? envelope.message ?? "flutterwave reported a failure",
        {
          provider: FLUTTERWAVE_PROVIDER_NAME,
          operation: options.operation,
          httpStatus: response.status,
          ...(envelope.message === undefined ? {} : { providerMessage: envelope.message }),
          ...(response.requestId === undefined ? {} : { requestId: response.requestId }),
        },
      );
    }

    return {
      data: envelope.data as T,
      message: envelope.message ?? "",
      meta: envelope.meta,
    };
  }

  /** Reject a reference that v4 would reject, before it is written to anything. */
  #assertReference(reference: string, operation: Operation): void {
    if (!REFERENCE.test(reference)) {
      throw new ValidationError(
        `flutterwave: the reference "${reference}" is not acceptable. Use 6 to 42 ` +
          "characters of letters, digits and hyphens. v3 accepts more than that, but " +
          "v4 enforces this pattern, so a reference outside it cannot be carried " +
          "forward when you migrate.",
        { provider: FLUTTERWAVE_PROVIDER_NAME, operation },
      );
    }
  }

  // ------------------------------------------------------------- collections

  /**
   * Create a hosted checkout and return its link.
   *
   * This is v3 Standard. v4 has no hosted page at all, which is why collections stay
   * on v3: charging a card on v4 means holding the card number, and naija-pay never
   * does that.
   */
  async createCheckout(options: {
    readonly amount: Money;
    readonly email: string;
    readonly reference: string;
    readonly name?: string;
    readonly phone?: string;
    readonly channels?: readonly Channel[];
    readonly callbackUrl?: string;
    readonly metadata?: Record<string, string>;
    readonly title?: string;
    readonly logoUrl?: string;
    readonly sessionDurationMinutes?: number;
    /** Split declaration from `createSplit`, or raw subaccount entries. */
    readonly subaccounts?: readonly FlutterwaveSubaccountEntry[];
    readonly paymentPlan?: number;
  }): Promise<{
    readonly reference: string;
    readonly checkoutUrl: string;
    readonly provider: string;
    readonly raw: unknown;
  }> {
    this.#assertReference(options.reference, "checkout.create");

    const channels = options.channels
      ?.map((channel) => CHANNEL_TO_FLUTTERWAVE[channel])
      .filter((channel): channel is string => channel !== undefined);

    if (options.channels && channels && channels.length !== options.channels.length) {
      const unsupported = options.channels.filter((c) => !CHANNEL_TO_FLUTTERWAVE[c]);
      throw new ValidationError(
        `flutterwave does not support the channel(s): ${unsupported.join(", ")}. ` +
          "See the capability matrix in PROVIDERS.md.",
        { provider: FLUTTERWAVE_PROVIDER_NAME, operation: "checkout.create" },
      );
    }

    const { data } = await this.#call<{ link: string }>({
      method: "POST",
      path: "/payments",
      operation: "checkout.create",
      // Safe to retry: Flutterwave keys off tx_ref, so a replay returns a link for the
      // same transaction rather than creating a second one.
      safety: "safe",
      body: {
        tx_ref: options.reference,
        // Decimal major units, converted and round-trip-checked. Never amount.amount.
        amount: toMajor(options.amount),
        currency: options.amount.currency,
        customer: {
          email: options.email,
          ...(options.name === undefined ? {} : { name: options.name }),
          ...(options.phone === undefined ? {} : { phone_number: options.phone }),
        },
        ...(options.callbackUrl === undefined ? {} : { redirect_url: options.callbackUrl }),
        // A comma-separated string, not an array. Flutterwave ignores an array here,
        // which silently offers every channel instead of the ones you asked for.
        ...(channels && channels.length > 0 ? { payment_options: channels.join(",") } : {}),
        ...(options.title === undefined && options.logoUrl === undefined
          ? {}
          : {
              customizations: {
                ...(options.title === undefined ? {} : { title: options.title }),
                ...(options.logoUrl === undefined ? {} : { logo: options.logoUrl }),
              },
            }),
        ...(options.sessionDurationMinutes === undefined
          ? {}
          : { configuration: { session_duration: options.sessionDurationMinutes } }),
        ...(options.subaccounts === undefined || options.subaccounts.length === 0
          ? {}
          : { subaccounts: options.subaccounts }),
        ...(options.paymentPlan === undefined ? {} : { payment_plan: options.paymentPlan }),
        ...(options.metadata === undefined ? {} : { meta: options.metadata }),
      },
    });

    return {
      reference: options.reference,
      checkoutUrl: data.link,
      provider: FLUTTERWAVE_PROVIDER_NAME,
      raw: data,
    };
  }

  /**
   * Verify a transaction by Flutterwave's numeric id.
   *
   * The id comes from the webhook or from `listTransactions`. If all you have is your
   * own reference, use `verifyTransactionByReference`.
   */
  async verifyTransaction(transactionId: string | number): Promise<Transaction> {
    const { data } = await this.#call({
      method: "GET",
      path: `/transactions/${encodeURIComponent(String(transactionId))}/verify`,
      operation: "transactions.verify",
      safety: "safe",
    });
    return toTransaction(data);
  }

  /** Verify by the `tx_ref` you chose, which is usually what an application holds. */
  async verifyTransactionByReference(reference: string): Promise<Transaction> {
    const { data } = await this.#call({
      method: "GET",
      path: "/transactions/verify_by_reference",
      operation: "transactions.verify",
      safety: "safe",
      query: { tx_ref: reference },
    });
    return toTransaction(data);
  }

  async listTransactions(
    options: {
      readonly page?: number;
      readonly from?: string;
      readonly to?: string;
      readonly currency?: string;
      readonly status?: string;
      readonly customerEmail?: string;
    } = {},
  ): Promise<{ readonly transactions: readonly Transaction[]; readonly meta: unknown }> {
    const { data, meta } = await this.#call<unknown[]>({
      method: "GET",
      path: "/transactions",
      operation: "transactions.list",
      safety: "safe",
      query: {
        page: options.page,
        from: options.from,
        to: options.to,
        currency: options.currency,
        status: options.status,
        customer_email: options.customerEmail,
      },
    });
    return {
      transactions: (Array.isArray(data) ? data : []).map(toTransaction),
      meta,
    };
  }

  /** Refund a transaction, fully or partially. */
  async createRefund(options: {
    readonly transactionId: string | number;
    readonly amount?: Money;
    readonly comments?: string;
    readonly callbackUrl?: string;
  }): Promise<Refund> {
    const { data } = await this.#call({
      method: "POST",
      path: `/transactions/${encodeURIComponent(String(options.transactionId))}/refund`,
      operation: "refunds.create",
      // Never retried: a replayed refund could refund twice. Flutterwave v3 has no
      // idempotency key — that is a v4 feature — so there is nothing to make this safe.
      safety: "money-moving",
      reference: String(options.transactionId),
      body: {
        ...(options.amount === undefined ? {} : { amount: toMajor(options.amount) }),
        ...(options.comments === undefined ? {} : { comments: options.comments }),
        // Flutterwave spells this one without a separator.
        ...(options.callbackUrl === undefined ? {} : { callbackurl: options.callbackUrl }),
      },
    });
    return toRefund(data);
  }

  /**
   * Refunds recorded against a transaction, as Flutterwave returns them.
   *
   * The route is `/refunds`, not `/transactions/refunds` — a distinction confirmed
   * against Flutterwave's reference page, having first been written the other way from
   * the documentation index.
   */
  async listRefunds(transactionId: string | number): Promise<readonly Refund[]> {
    const { data } = await this.#call<unknown[]>({
      method: "GET",
      path: "/refunds",
      operation: "refunds.status",
      safety: "safe",
      query: { id: String(transactionId) },
    });
    return (Array.isArray(data) ? data : []).map(toRefund);
  }

  // -------------------------------------------------------- virtual accounts

  /**
   * Create a static (permanent) virtual account for a customer.
   *
   * CBN rules mean a permanent NGN account needs a BVN or a NIN; Flutterwave accepts
   * either. We fail locally with that message rather than relaying an opaque rejection.
   */
  async createStaticVirtualAccount(options: {
    readonly email: string;
    readonly reference: string;
    readonly bvn?: string;
    readonly nin?: string;
    readonly firstName?: string;
    readonly lastName?: string;
    readonly phone?: string;
    readonly narration?: string;
    readonly bankCode?: string;
  }): Promise<VirtualAccount> {
    assertSupported(this.capabilities, "virtualAccounts.createStatic");
    this.#assertReference(options.reference, "virtualAccounts.createStatic");

    if (!options.bvn && !options.nin) {
      throw new KycRequiredError(
        "flutterwave: a BVN or a NIN is required for a permanent virtual account " +
          "under CBN rules. Flutterwave accepts either.",
        {
          provider: FLUTTERWAVE_PROVIDER_NAME,
          operation: "virtualAccounts.createStatic",
          required: ["bvn"],
        },
      );
    }

    const { data } = await this.#call({
      method: "POST",
      path: "/virtual-account-numbers",
      operation: "virtualAccounts.createStatic",
      safety: "safe",
      body: {
        email: options.email,
        is_permanent: true,
        tx_ref: options.reference,
        ...(options.bvn === undefined ? {} : { bvn: options.bvn }),
        ...(options.nin === undefined ? {} : { nin: options.nin }),
        ...(options.firstName === undefined ? {} : { firstname: options.firstName }),
        ...(options.lastName === undefined ? {} : { lastname: options.lastName }),
        ...(options.phone === undefined ? {} : { phonenumber: options.phone }),
        ...(options.narration === undefined ? {} : { narration: options.narration }),
        ...(options.bankCode === undefined ? {} : { bank_code: options.bankCode }),
      },
    });
    return toVirtualAccount(data, { reference: options.reference, kind: "static" });
  }

  /**
   * Create a dynamic virtual account that expires.
   *
   * Flutterwave does offer this, which Paystack does not: a per-transaction account
   * for a fixed amount. `expiresInSeconds` defaults to Flutterwave's own 60 seconds —
   * deliberately not changed, because a longer default would quietly widen the window
   * in which a stale account still accepts money.
   */
  async createDynamicVirtualAccount(options: {
    readonly email: string;
    readonly reference: string;
    readonly amount: Money;
    readonly expiresInSeconds?: number;
    readonly narration?: string;
    readonly bankCode?: string;
  }): Promise<VirtualAccount> {
    assertSupported(this.capabilities, "virtualAccounts.createDynamic");
    this.#assertReference(options.reference, "virtualAccounts.createDynamic");

    const { data } = await this.#call({
      method: "POST",
      path: "/virtual-account-numbers",
      operation: "virtualAccounts.createDynamic",
      safety: "safe",
      body: {
        email: options.email,
        is_permanent: false,
        tx_ref: options.reference,
        amount: toMajor(options.amount),
        ...(options.expiresInSeconds === undefined
          ? {}
          : { expires: String(options.expiresInSeconds) }),
        ...(options.narration === undefined ? {} : { narration: options.narration }),
        ...(options.bankCode === undefined ? {} : { bank_code: options.bankCode }),
      },
    });
    return toVirtualAccount(data, { reference: options.reference, kind: "dynamic" });
  }

  async getVirtualAccount(orderReference: string): Promise<VirtualAccount> {
    const { data } = await this.#call({
      method: "GET",
      path: `/virtual-account-numbers/${encodeURIComponent(orderReference)}`,
      operation: "virtualAccounts.get",
      safety: "safe",
    });
    return toVirtualAccount(data);
  }

  /**
   * Update the BVN on a static virtual account. Flutterwave has no NIN equivalent.
   *
   * `PUT /virtual-account-numbers/{order_ref}` with the BVN alone in the body. There is
   * no `/update-bvn` route; the order reference goes in the path.
   */
  async updateVirtualAccountBvn(options: {
    readonly orderReference: string;
    readonly bvn: string;
  }): Promise<{ readonly message: string; readonly raw: unknown }> {
    const { data, message } = await this.#call({
      method: "PUT",
      path: `/virtual-account-numbers/${encodeURIComponent(options.orderReference)}`,
      operation: "virtualAccounts.updateKyc",
      safety: "unsafe",
      body: { bvn: options.bvn },
    });
    return { message, raw: data };
  }

  /**
   * Deactivate a virtual account, so it stops accepting money.
   *
   * One endpoint serves both directions: `POST /virtual-account-numbers/{order_ref}`
   * with `status` of `"inactive"` or `"active"`. It is a POST, not a PUT.
   */
  async deactivateVirtualAccount(
    orderReference: string,
  ): Promise<{ readonly message: string; readonly raw: unknown }> {
    return await this.#setVirtualAccountStatus(orderReference, "inactive");
  }

  /** Reactivate a deactivated virtual account. The same endpoint, the other status. */
  async reactivateVirtualAccount(
    orderReference: string,
  ): Promise<{ readonly message: string; readonly raw: unknown }> {
    return await this.#setVirtualAccountStatus(orderReference, "active");
  }

  async #setVirtualAccountStatus(
    orderReference: string,
    status: "active" | "inactive",
  ): Promise<{ readonly message: string; readonly raw: unknown }> {
    const { data, message } = await this.#call({
      method: "POST",
      path: `/virtual-account-numbers/${encodeURIComponent(orderReference)}`,
      operation: "virtualAccounts.deactivate",
      // Not retried: flipping an account's status twice is not harmless, because the
      // second attempt could race a deliberate change made in between.
      safety: "unsafe",
      body: { status },
    });
    return { message, raw: data };
  }

  // ------------------------------------------------- split-payment accounts

  /**
   * Create a collection subaccount — the vendor side of a split payment.
   *
   * `shareBasisPoints` is our unit; Flutterwave wants a decimal fraction, so 900
   * becomes `0.09`. For a flat default share, pass `flatShare` instead.
   */
  async createSplitAccount(options: {
    readonly businessName: string;
    readonly accountNumber: string;
    readonly bankCode: string;
    readonly businessMobile: string;
    readonly country?: string;
    readonly shareBasisPoints?: number;
    readonly flatShare?: Money;
    readonly businessEmail?: string;
    readonly businessContact?: string;
  }): Promise<SplitAccount> {
    assertSupported(this.capabilities, "splitAccounts.create");

    if ((options.shareBasisPoints === undefined) === (options.flatShare === undefined)) {
      throw new ValidationError(
        "flutterwave: give exactly one of shareBasisPoints or flatShare for a " +
          "subaccount's default share. Flutterwave stores one split_type per " +
          "subaccount, so it cannot be both, and it cannot be neither.",
        { provider: FLUTTERWAVE_PROVIDER_NAME, operation: "splitAccounts.create" },
      );
    }

    const isFlat = options.flatShare !== undefined;
    const { data } = await this.#call({
      method: "POST",
      path: "/subaccounts",
      operation: "splitAccounts.create",
      safety: "safe",
      body: {
        account_bank: options.bankCode,
        account_number: options.accountNumber,
        business_name: options.businessName,
        business_mobile: options.businessMobile,
        country: options.country ?? "NG",
        split_type: isFlat ? "flat" : "percentage",
        split_value: isFlat
          ? // biome-ignore lint/style/noNonNullAssertion: isFlat proves it is present.
            toMajor(options.flatShare!)
          : // biome-ignore lint/style/noNonNullAssertion: the exclusive check above proves it.
            basisPointsToFraction(options.shareBasisPoints!),
        ...(options.businessEmail === undefined ? {} : { business_email: options.businessEmail }),
        ...(options.businessContact === undefined
          ? {}
          : { business_contact: options.businessContact }),
      },
    });
    return toSplitAccount(data);
  }

  async listSplitAccounts(
    options: { readonly page?: number } = {},
  ): Promise<{ readonly accounts: readonly SplitAccount[]; readonly meta: unknown }> {
    const { data, meta } = await this.#call<unknown[]>({
      method: "GET",
      path: "/subaccounts",
      operation: "splitAccounts.list",
      safety: "safe",
      query: { page: options.page },
    });
    return { accounts: (Array.isArray(data) ? data : []).map(toSplitAccount), meta };
  }

  async updateSplitAccount(options: {
    readonly subaccountId: string;
    readonly businessName?: string;
    readonly accountNumber?: string;
    readonly bankCode?: string;
    readonly shareBasisPoints?: number;
    readonly flatShare?: Money;
  }): Promise<SplitAccount> {
    if (options.shareBasisPoints !== undefined && options.flatShare !== undefined) {
      throw new ValidationError("flutterwave: give at most one of shareBasisPoints or flatShare.", {
        provider: FLUTTERWAVE_PROVIDER_NAME,
        operation: "splitAccounts.update",
      });
    }

    const { data } = await this.#call({
      method: "PUT",
      path: `/subaccounts/${encodeURIComponent(options.subaccountId)}`,
      operation: "splitAccounts.update",
      safety: "unsafe",
      body: {
        ...(options.businessName === undefined ? {} : { business_name: options.businessName }),
        ...(options.accountNumber === undefined ? {} : { account_number: options.accountNumber }),
        ...(options.bankCode === undefined ? {} : { account_bank: options.bankCode }),
        ...(options.shareBasisPoints === undefined
          ? {}
          : {
              split_type: "percentage",
              split_value: basisPointsToFraction(options.shareBasisPoints),
            }),
        ...(options.flatShare === undefined
          ? {}
          : { split_type: "flat", split_value: toMajor(options.flatShare) }),
      },
    });
    return toSplitAccount(data);
  }

  async deactivateSplitAccount(
    subaccountId: string,
  ): Promise<{ readonly message: string; readonly raw: unknown }> {
    const { data, message } = await this.#call({
      method: "DELETE",
      path: `/subaccounts/${encodeURIComponent(subaccountId)}`,
      operation: "splitAccounts.deactivate",
      safety: "unsafe",
    });
    return { message, raw: data };
  }

  /**
   * Build a split declaration for a checkout.
   *
   * **Makes no network call.** Flutterwave has no split object: unlike Paystack, which
   * creates a `SPL_` code you reuse, Flutterwave declares the split inline on each
   * payment. This returns the array to hand to `createCheckout`, with our basis points
   * converted to Flutterwave's decimal fractions and the ratio semantics explained.
   *
   * Two things worth knowing before you use it, both from Flutterwave's own docs:
   *
   * - Whoever receives the remainder bears Flutterwave's fee. With `percentage` or
   *   `flat`, that is the subaccount; with `flatSubaccount`, it is you.
   * - `ratio` weights are relative, not percentages: 2, 3 and 5 split the settlement
   *   amount into tenths, and the settlement amount is what is left after your
   *   commission and Flutterwave's fee.
   */
  createSplit(
    parties: readonly {
      readonly subaccountId: string;
      /** Your commission from this subaccount's share, in basis points. */
      readonly commissionBasisPoints?: number;
      /** Your commission as a flat amount, taken from the subaccount's share. */
      readonly commissionFlat?: Money;
      /** A fixed amount the subaccount receives; you bear Flutterwave's fee. */
      readonly subaccountReceives?: Money;
      /** Relative weight when several subaccounts share the settlement amount. */
      readonly ratio?: number;
    }[],
  ): readonly FlutterwaveSubaccountEntry[] {
    assertSupported(this.capabilities, "splits.create");

    return parties.map((party) => {
      const modes = [
        party.commissionBasisPoints !== undefined,
        party.commissionFlat !== undefined,
        party.subaccountReceives !== undefined,
      ].filter(Boolean).length;

      if (modes > 1) {
        throw new ValidationError(
          `flutterwave: subaccount "${party.subaccountId}" names more than one of ` +
            "commissionBasisPoints, commissionFlat and subaccountReceives. Flutterwave " +
            "takes one transaction_charge_type per subaccount.",
          { provider: FLUTTERWAVE_PROVIDER_NAME, operation: "splits.create" },
        );
      }

      const entry: FlutterwaveSubaccountEntry = {
        id: party.subaccountId,
        ...(party.ratio === undefined ? {} : { transaction_split_ratio: party.ratio }),
        ...(party.commissionBasisPoints === undefined
          ? {}
          : {
              transaction_charge_type: "percentage",
              transaction_charge: basisPointsToFraction(party.commissionBasisPoints),
            }),
        ...(party.commissionFlat === undefined
          ? {}
          : {
              transaction_charge_type: "flat",
              transaction_charge: toMajor(party.commissionFlat),
            }),
        ...(party.subaccountReceives === undefined
          ? {}
          : {
              transaction_charge_type: "flat_subaccount",
              transaction_charge: toMajor(party.subaccountReceives),
            }),
      };
      return entry;
    });
  }

  // --------------------------------------------------------------- wallets

  /**
   * Open a payout subaccount: a real NGN wallet with its own NUBAN.
   *
   * This is the capability Paystack has no answer to. The wallet holds a balance,
   * receives money through its own account number, and can pay out from that balance
   * rather than from yours.
   *
   * Keep both identifiers the result carries. `reference` reads the balance and debits
   * the wallet; `barterId` is the destination for a wallet-to-wallet transfer.
   */
  async openWallet(options: {
    readonly accountName: string;
    readonly email: string;
    readonly phone?: string;
    readonly country?: string;
  }): Promise<WalletAccount> {
    const { data } = await this.#call({
      method: "POST",
      path: "/payout-subaccounts",
      operation: "wallets.open",
      safety: "safe",
      body: {
        account_name: options.accountName,
        email: options.email,
        country: options.country ?? "NG",
        ...(options.phone === undefined ? {} : { mobilenumber: options.phone }),
      },
    });
    return toWalletAccount(data);
  }

  /**
   * A wallet's balance.
   *
   * NGN only: Flutterwave's documentation says payout subaccount wallets are designed
   * to hold NGN balances, so another currency fails locally rather than returning a
   * zero that looks like an empty wallet.
   */
  async getWalletBalance(options: {
    readonly reference: string;
    readonly currency?: string;
  }): Promise<WalletBalance> {
    const currency = options.currency ?? "NGN";
    if (currency !== "NGN") {
      throw new ValidationError(
        `flutterwave: payout subaccount wallets hold NGN only, so a ${currency} ` +
          "balance does not exist. Flutterwave's own documentation states this.",
        { provider: FLUTTERWAVE_PROVIDER_NAME, operation: "wallets.balance" },
      );
    }

    const { data } = await this.#call({
      method: "GET",
      path: `/payout-subaccounts/${encodeURIComponent(options.reference)}/balances`,
      operation: "wallets.balance",
      safety: "safe",
      query: { currency },
    });
    return toWalletBalance(data, options.reference);
  }

  /**
   * A wallet's statement.
   *
   * `from` and `to` are **required by Flutterwave**, not optional, so they are required
   * here too — asking for a statement with no date range fails at the provider with a
   * message that does not say which field is missing.
   */
  async getWalletStatement(options: {
    readonly reference: string;
    readonly from: string;
    readonly to: string;
    readonly currency?: string;
    readonly page?: number;
    readonly fetchLimit?: number;
  }): Promise<{ readonly transactions: readonly Transaction[]; readonly meta: unknown }> {
    assertSupported(this.capabilities, "wallets.statement");

    if (!options.from || !options.to) {
      throw new ValidationError(
        "flutterwave: a wallet statement needs both from and to dates. Flutterwave " +
          "requires the range and does not say which field is missing when it is absent.",
        { provider: FLUTTERWAVE_PROVIDER_NAME, operation: "wallets.statement" },
      );
    }

    const { data, meta } = await this.#call<unknown[]>({
      method: "GET",
      // The reference is a path segment, not a query parameter.
      path: `/payout-subaccounts/${encodeURIComponent(options.reference)}/transactions`,
      operation: "wallets.statement",
      safety: "safe",
      query: {
        from: options.from,
        to: options.to,
        currency: options.currency,
        page: options.page,
        fetch_limit: options.fetchLimit,
      },
    });
    return { transactions: (Array.isArray(data) ? data : []).map(toTransaction), meta };
  }

  /**
   * Pay out from a wallet's own balance rather than yours.
   *
   * The same endpoint as `createPayout`, with `debit_subaccount` naming the wallet.
   * Destination is either a bank account, or another wallet by its barter id.
   */
  async transferFromWallet(options: {
    readonly walletReference: string;
    readonly amount: Money;
    readonly reference: string;
    readonly accountNumber?: string;
    readonly bankCode?: string;
    readonly toBarterId?: string;
    readonly narration?: string;
    readonly callbackUrl?: string;
  }): Promise<Payout> {
    assertSupported(this.capabilities, "wallets.transfer");
    this.#assertReference(options.reference, "wallets.transfer");

    const toBank = options.accountNumber !== undefined && options.bankCode !== undefined;
    const toWallet = options.toBarterId !== undefined;
    if (toBank === toWallet) {
      throw new ValidationError(
        "flutterwave: a wallet transfer needs exactly one destination — either " +
          "accountNumber with bankCode, or toBarterId for another wallet.",
        { provider: FLUTTERWAVE_PROVIDER_NAME, operation: "wallets.transfer" },
      );
    }

    const { data } = await this.#call({
      method: "POST",
      path: "/transfers",
      operation: "wallets.transfer",
      safety: "money-moving",
      reference: options.reference,
      body: {
        // Flutterwave's own sentinel for an internal destination.
        account_bank: toWallet ? "flutterwave" : options.bankCode,
        account_number: toWallet ? options.toBarterId : options.accountNumber,
        amount: toMajor(options.amount),
        currency: options.amount.currency,
        debit_currency: options.amount.currency,
        debit_subaccount: options.walletReference,
        reference: options.reference,
        ...(options.narration === undefined ? {} : { narration: options.narration }),
        ...(options.callbackUrl === undefined ? {} : { callback_url: options.callbackUrl }),
      },
    });
    return toPayout(data);
  }

  // --------------------------------------------------------------- payouts

  async listBanks(country = "NG"): Promise<
    readonly {
      readonly code: string;
      readonly name: string;
      readonly id: string;
      readonly institution: BankAccount["institution"];
      readonly mergerWarning: string | null;
    }[]
  > {
    const { data } = await this.#call<{ id?: number; code?: string; name?: string }[]>({
      method: "GET",
      path: `/banks/${encodeURIComponent(country)}`,
      operation: "banks.list",
      safety: "safe",
    });

    return (Array.isArray(data) ? data : []).map((bank) => {
      const enriched = enrich({
        accountNumber: "",
        accountName: "",
        bankName: bank.name ?? null,
        bankCode: bank.code ?? null,
        bankId: bank.id === undefined ? null : String(bank.id),
      });
      return {
        code: bank.code ?? "",
        name: bank.name ?? "",
        id: bank.id === undefined ? "" : String(bank.id),
        institution: enriched.institution,
        mergerWarning: enriched.mergerWarning,
      };
    });
  }

  /**
   * Resolve an account number to its holder's name.
   *
   * Flutterwave's response does not echo the bank code, so the requested code is
   * carried through — otherwise the enriched result would have no code to match on.
   */
  async resolveAccount(options: {
    readonly accountNumber: string;
    readonly bankCode: string;
  }): Promise<BankAccount> {
    const { data } = await this.#call<{ account_number: string; account_name: string }>({
      method: "POST",
      path: "/accounts/resolve",
      operation: "banks.resolveAccount",
      // A lookup with no side effect, despite being a POST.
      safety: "safe",
      body: { account_number: options.accountNumber, account_bank: options.bankCode },
    });

    return enrich({
      accountNumber: data.account_number ?? options.accountNumber,
      accountName: data.account_name,
      bankCode: options.bankCode,
    });
  }

  /**
   * Send money to a bank account.
   *
   * Unlike Paystack, Flutterwave needs no recipient object first — the account number
   * and bank code go straight on the transfer. The returned payout is `pending`, not
   * successful: Flutterwave queues transfers, and `data.status` is `NEW`.
   */
  async createPayout(options: {
    readonly amount: Money;
    readonly accountNumber: string;
    readonly bankCode: string;
    readonly reference: string;
    readonly accountName?: string;
    readonly narration?: string;
    readonly callbackUrl?: string;
    readonly debitCurrency?: string;
  }): Promise<Payout> {
    assertSupported(this.capabilities, "payouts.create");
    this.#assertReference(options.reference, "payouts.create");

    const { data } = await this.#call({
      method: "POST",
      path: "/transfers",
      operation: "payouts.create",
      // The money-moving call. Never retried, never failed over.
      safety: "money-moving",
      reference: options.reference,
      body: {
        account_bank: options.bankCode,
        account_number: options.accountNumber,
        amount: toMajor(options.amount),
        currency: options.amount.currency,
        debit_currency: options.debitCurrency ?? options.amount.currency,
        reference: options.reference,
        ...(options.narration === undefined ? {} : { narration: options.narration }),
        ...(options.accountName === undefined ? {} : { beneficiary_name: options.accountName }),
        ...(options.callbackUrl === undefined ? {} : { callback_url: options.callbackUrl }),
      },
    });
    return toPayout(data);
  }

  /** A transfer's current state, by Flutterwave's numeric transfer id. */
  async getPayout(transferId: string | number): Promise<Payout> {
    const { data } = await this.#call({
      method: "GET",
      path: `/transfers/${encodeURIComponent(String(transferId))}`,
      operation: "payouts.status",
      safety: "safe",
    });
    return toPayout(data);
  }

  /**
   * Balances, as integer minor units.
   *
   * Flutterwave reports these as decimals — `20000.5` is NGN 20,000.50 — and they are
   * converted here, so a caller never has to know that.
   */
  async getBalance(): Promise<readonly { readonly amount: number; readonly currency: string }[]> {
    const { data } = await this.#call<{ currency?: string; available_balance?: number }[]>({
      method: "GET",
      path: "/balances",
      operation: "balance.get",
      safety: "safe",
    });

    const out: { amount: number; currency: string }[] = [];
    for (const entry of Array.isArray(data) ? data : []) {
      const currency = entry.currency ?? "NGN";
      const balance = toWalletBalance({ currency, available_balance: entry.available_balance }, "");
      // A balance we cannot convert exactly is omitted rather than reported as zero,
      // which would read as an empty account.
      if (balance.available) out.push({ amount: balance.available.amount, currency });
    }
    return out;
  }

  // ---------------------------------------------------------------- webhooks

  /**
   * Verify a webhook from Flutterwave.
   *
   * `body` must be the raw bytes exactly as received. Parsing or re-serialising first
   * guarantees a mismatch, and it is the single most common cause of "my signature
   * does not verify".
   *
   * Flutterwave has two schemes, and this picks by the headers present:
   *
   * - `flutterwave-signature` (v4) is a real HMAC-SHA256 over the raw body. Verified
   *   properly and reported as `full-body`.
   * - `verif-hash` (v3) carries the secret hash itself. Identical on every request,
   *   covering none of the payload, so it proves only that the sender knows the
   *   secret. Reported as `shared-secret`, never dressed up as a signature.
   *
   * The `strength` in the result is the strength of the scheme actually used, so an
   * application that requires `full-body` can refuse a v3 delivery. Both schemes use
   * the secret hash from the dashboard, which is `webhookSecretHash`, not the API key.
   */
  async verifyWebhook(options: {
    readonly body: Uint8Array;
    readonly headers: Readonly<Record<string, string>>;
  }): Promise<VerificationResult & { readonly apiVersion: "v3" | "v4" | "unknown" }> {
    assertSupported(this.capabilities, "webhooks.verify");

    if (this.#webhookSecretHash === undefined) {
      throw new ConfigurationError(
        "flutterwave: webhookSecretHash is required to verify webhooks. It is the " +
          "secret hash you set under Settings > Webhooks on the Flutterwave " +
          "dashboard, and it is not the API secret key — unlike Paystack, which signs " +
          "with the secret key.",
        { provider: FLUTTERWAVE_PROVIDER_NAME, operation: "webhooks.verify" },
      );
    }

    const headers = lowercaseKeys(options.headers);
    const hasV4 = typeof headers["flutterwave-signature"] === "string";
    const hasV3 = typeof headers["verif-hash"] === "string";

    if (!hasV4 && !hasV3) {
      return {
        verified: false,
        strength: "unverified",
        reason:
          'neither the "flutterwave-signature" header (v4) nor the "verif-hash" ' +
          "header (v3) is present, so this delivery cannot be verified at all.",
        apiVersion: "unknown",
      };
    }

    // v4 first: when both are present, verify the one that actually proves something.
    const scheme = hasV4 ? SCHEMES.flutterwaveV4 : SCHEMES.flutterwaveV3;
    const result = await verifySignature({
      scheme,
      body: options.body,
      headers,
      secret: this.#webhookSecretHash,
    });
    return { ...result, apiVersion: hasV4 ? "v4" : "v3" };
  }
}

/** A `subaccounts` entry on a v3 checkout, as Flutterwave's API spells it. */
export interface FlutterwaveSubaccountEntry {
  readonly id: string;
  readonly transaction_split_ratio?: number;
  readonly transaction_charge_type?: "flat" | "percentage" | "flat_subaccount";
  readonly transaction_charge?: number;
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

/** Create a Flutterwave provider. */
export function flutterwave(options: FlutterwaveOptions): FlutterwaveProvider {
  return new FlutterwaveProvider(options);
}
