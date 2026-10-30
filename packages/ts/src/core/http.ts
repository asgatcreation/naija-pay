/**
 * The HTTP layer.
 *
 * Built on `fetch`, so there is no runtime dependency. The `fetch` implementation is
 * injectable, which is how every retry, backoff and timeout path below is tested
 * without a network.
 *
 * The one rule that matters most here: **retries are decided by the operation, not by
 * the error.** A network timeout on a payout looks exactly like a network timeout on a
 * balance lookup, but retrying the first can pay someone twice. So every request
 * declares its own safety, and the client refuses to retry anything that might have
 * already moved money — no matter what the HTTP status says.
 */

import {
  AuthenticationError,
  NaijaPayError,
  NetworkError,
  PayoutStatusUnknownError,
  ProviderDownError,
  RateLimitedError,
  errorClassForStatus,
} from "./errors.ts";
import { redact, redactObject } from "./redact.ts";

/**
 * How safe this request is to send more than once.
 *
 * - `safe`         A read, or a write the provider makes idempotent by reference or by
 *                  an idempotency key. Retried on transport and capacity failures.
 * - `money-moving` A payout, refund or mandate debit. **Never retried.** If the
 *                  transport fails, the outcome is genuinely unknown and the caller
 *                  gets `PayoutStatusUnknownError` telling them to query by reference.
 * - `unsafe`       Anything else that creates state without a reference we control.
 *                  Not retried, but an ordinary error is raised rather than the payout
 *                  variant.
 */
export type RequestSafety = "safe" | "unsafe" | "money-moving";

export interface RetryPolicy {
  /** Total attempts, including the first. 1 disables retrying. */
  readonly attempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  attempts: 3,
  baseDelayMs: 200,
  maxDelayMs: 4_000,
};

export interface LogEvent {
  readonly provider: string;
  readonly operation: string | undefined;
  readonly method: string;
  /** Path only — never the query string, which could carry personal data. */
  readonly path: string;
  readonly attempt: number;
  readonly status?: number;
  readonly durationMs: number;
  readonly outcome: "success" | "retrying" | "failed";
  readonly error?: string;
  readonly requestId?: string;
}

export interface HttpClientOptions {
  readonly provider: string;
  readonly baseUrl: string;
  /** Static headers, typically authorization. Redacted before any logging. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Per-request headers resolved at call time, for token-based auth. */
  readonly authorize?: () => Promise<Record<string, string>> | Record<string, string>;
  readonly timeoutMs?: number;
  readonly retry?: RetryPolicy;
  readonly onLog?: (event: LogEvent) => void;
  /** Injected for tests, and for runtimes with a non-global fetch. */
  readonly fetch?: typeof globalThis.fetch;
  /** Injected for tests so backoff does not actually sleep. */
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * Maps a provider's own error payload onto one of our typed errors. Adapters supply
   * this; without it the HTTP status alone decides.
   */
  readonly classifyError?: (
    status: number,
    body: unknown,
  ) => { readonly error: typeof NaijaPayError; readonly message?: string } | undefined;
  /** Header carrying the provider's request id, when it has one. */
  readonly requestIdHeader?: string;
}

export interface RequestOptions {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  /** Required: there is no default, because guessing it wrong can pay twice. */
  readonly safety: RequestSafety;
  /** The naija-pay operation, for errors and logs. */
  readonly operation?: string;
  /**
   * Sent as an idempotency header where the provider supports one. Flutterwave v4
   * documents `X-Idempotency-Key`; most others key off the transaction reference
   * instead.
   */
  readonly idempotencyKey?: string;
  readonly idempotencyHeader?: string;
  /** For `money-moving` requests, so the error can tell the caller what to query. */
  readonly reference?: string;
}

export interface HttpResponse<T = unknown> {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: T;
  /** Raw response text, kept for webhook-adjacent and debugging paths. */
  readonly raw: string;
  readonly requestId: string | undefined;
  readonly attempts: number;
}

/** Full jitter: delay is random in [0, min(max, base * 2^n)]. */
function backoffDelay(attempt: number, policy: RetryPolicy, random: () => number): number {
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
  return Math.floor(random() * ceiling);
}

/** `Retry-After` may be seconds or an HTTP date; both are documented. */
function parseRetryAfter(value: string | undefined, now: number): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.floor(seconds * 1_000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - now);
  return undefined;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class HttpClient {
  readonly #options: HttpClientOptions;
  readonly #fetch: typeof globalThis.fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #retry: RetryPolicy;
  readonly #timeoutMs: number;
  /** Overridable only for tests; production always uses Math.random. */
  random: () => number = Math.random;

  constructor(options: HttpClientOptions) {
    this.#options = options;
    const injected = options.fetch ?? globalThis.fetch;
    if (typeof injected !== "function") {
      throw new TypeError(
        "no fetch implementation available; pass one via options.fetch " +
          "(Node 18+, Bun, Deno and modern browsers all provide a global fetch)",
      );
    }
    // Bind so an injected global fetch is not called with the wrong receiver.
    this.#fetch = injected.bind(globalThis);
    this.#sleep = options.sleep ?? defaultSleep;
    this.#retry = options.retry ?? DEFAULT_RETRY_POLICY;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
  }

  async request<T = unknown>(options: RequestOptions): Promise<HttpResponse<T>> {
    const url = this.#buildUrl(options);
    // Only `safe` requests may ever be sent twice.
    const maxAttempts = options.safety === "safe" ? Math.max(1, this.#retry.attempts) : 1;

    let lastError: NaijaPayError | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const startedAt = Date.now();
      try {
        const response = await this.#send(url, options);
        const durationMs = Date.now() - startedAt;
        const requestId = this.#requestIdFrom(response.headers);

        if (response.status >= 200 && response.status < 300) {
          this.#log({
            provider: this.#options.provider,
            operation: options.operation,
            method: options.method,
            path: options.path,
            attempt,
            status: response.status,
            durationMs,
            outcome: "success",
            ...(requestId === undefined ? {} : { requestId }),
          });
          return { ...response, requestId, attempts: attempt } as HttpResponse<T>;
        }

        const error = this.#errorFor(response, options, requestId);
        lastError = error;

        const canRetry = attempt < maxAttempts && error.retryable;
        this.#log({
          provider: this.#options.provider,
          operation: options.operation,
          method: options.method,
          path: options.path,
          attempt,
          status: response.status,
          durationMs,
          outcome: canRetry ? "retrying" : "failed",
          error: error.name,
          ...(requestId === undefined ? {} : { requestId }),
        });

        if (!canRetry) throw error;

        const retryAfter =
          error instanceof RateLimitedError
            ? parseRetryAfter(response.headers["retry-after"], Date.now())
            : undefined;
        await this.#sleep(retryAfter ?? backoffDelay(attempt, this.#retry, this.random));
        continue;
      } catch (thrown) {
        // A NaijaPayError here is one we just raised deliberately.
        if (thrown instanceof NaijaPayError) throw thrown;

        const durationMs = Date.now() - startedAt;
        const transportError = this.#transportErrorFor(thrown, options);
        lastError = transportError;

        const canRetry = attempt < maxAttempts && transportError.retryable;
        this.#log({
          provider: this.#options.provider,
          operation: options.operation,
          method: options.method,
          path: options.path,
          attempt,
          durationMs,
          outcome: canRetry ? "retrying" : "failed",
          error: transportError.name,
        });

        if (!canRetry) throw transportError;
        await this.#sleep(backoffDelay(attempt, this.#retry, this.random));
      }
    }

    /* c8 ignore next 2 -- unreachable: the loop always returns or throws */
    throw lastError ?? new NetworkError("request failed with no recorded error");
  }

  #buildUrl(options: RequestOptions): string {
    const base = this.#options.baseUrl.replace(/\/+$/, "");
    const path = options.path.startsWith("/") ? options.path : `/${options.path}`;
    const url = new URL(base + path);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  async #send(
    url: string,
    options: RequestOptions,
  ): Promise<{ status: number; headers: Record<string, string>; body: unknown; raw: string }> {
    const headers: Record<string, string> = {
      accept: "application/json",
      ...this.#options.headers,
      ...(await this.#authHeaders()),
      ...options.headers,
    };

    if (options.idempotencyKey) {
      headers[options.idempotencyHeader ?? "x-idempotency-key"] = options.idempotencyKey;
    }

    let payload: string | undefined;
    if (options.body !== undefined) {
      payload = JSON.stringify(options.body);
      headers["content-type"] = "application/json";
    }

    // AbortSignal.timeout is available on every runtime we support, but a caller may
    // inject a fetch that ignores it, so the timeout is not the only safeguard.
    const signal = AbortSignal.timeout(this.#timeoutMs);

    const response = await this.#fetch(url, {
      method: options.method,
      headers,
      ...(payload === undefined ? {} : { body: payload }),
      signal,
    });

    const raw = await response.text();
    let body: unknown = raw;
    const contentType = response.headers.get("content-type") ?? "";
    if (raw !== "" && (contentType.includes("json") || raw.trimStart().startsWith("{"))) {
      try {
        body = JSON.parse(raw);
      } catch {
        // Leave it as text. A provider returning an HTML error page is a real case,
        // and the status code still classifies it correctly.
        body = raw;
      }
    }

    const headerBag: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headerBag[key.toLowerCase()] = value;
    });

    return { status: response.status, headers: headerBag, body, raw };
  }

  async #authHeaders(): Promise<Record<string, string>> {
    if (!this.#options.authorize) return {};
    return await this.#options.authorize();
  }

  #requestIdFrom(headers: Record<string, string>): string | undefined {
    const name = this.#options.requestIdHeader?.toLowerCase();
    return name ? headers[name] : undefined;
  }

  #errorFor(
    response: { status: number; headers: Record<string, string>; body: unknown },
    options: RequestOptions,
    requestId: string | undefined,
  ): NaijaPayError {
    const classified = this.#options.classifyError?.(response.status, response.body);
    const ErrorClass = classified?.error ?? errorClassForStatus(response.status);

    const providerMessage = extractMessage(response.body);
    const message =
      classified?.message ??
      providerMessage ??
      `${this.#options.provider} returned HTTP ${response.status}`;

    const context = {
      provider: this.#options.provider,
      ...(options.operation === undefined ? {} : { operation: options.operation }),
      httpStatus: response.status,
      ...(providerMessage === undefined ? {} : { providerMessage }),
      ...(requestId === undefined ? {} : { requestId }),
      ...(extractCode(response.body) === undefined
        ? {}
        : { providerCode: extractCode(response.body) }),
    };

    if (ErrorClass === RateLimitedError) {
      const retryAfter = parseRetryAfter(response.headers["retry-after"], Date.now());
      return new RateLimitedError(message, {
        ...context,
        ...(retryAfter === undefined ? {} : { retryAfterSeconds: Math.ceil(retryAfter / 1_000) }),
      });
    }

    // A 5xx on a money-moving request is the dangerous case: the provider may well
    // have accepted it. Never report that as retryable.
    if (options.safety === "money-moving" && response.status >= 500) {
      return new PayoutStatusUnknownError(
        `${this.#options.provider} returned HTTP ${response.status} on a money-moving request. ` +
          "The outcome is unknown and this must NOT be retried blindly — " +
          "query the status by reference instead.",
        { ...context, reference: options.reference ?? options.idempotencyKey ?? "unknown" },
      );
    }

    return new (ErrorClass as typeof NaijaPayError)(message, context);
  }

  #transportErrorFor(thrown: unknown, options: RequestOptions): NaijaPayError {
    const detail = thrown instanceof Error ? thrown.message : String(thrown);
    const isTimeout = thrown instanceof Error && thrown.name === "TimeoutError";
    const what = isTimeout ? `timed out after ${this.#timeoutMs}ms` : `failed: ${redact(detail)}`;

    const context = {
      provider: this.#options.provider,
      ...(options.operation === undefined ? {} : { operation: options.operation }),
      cause: thrown,
    };

    // The whole reason `safety` is a required field: a transport failure on a payout
    // may have been accepted by the provider, so retrying could pay twice.
    if (options.safety === "money-moving") {
      return new PayoutStatusUnknownError(
        `the request to ${this.#options.provider} ${what}, on a money-moving request. ` +
          "The outcome is unknown and this must NOT be retried blindly — " +
          "query the status by reference instead.",
        { ...context, reference: options.reference ?? options.idempotencyKey ?? "unknown" },
      );
    }

    return new NetworkError(`the request to ${this.#options.provider} ${what}`, context);
  }

  #log(event: LogEvent): void {
    if (!this.#options.onLog) return;
    // Redacted before it leaves: a log hook is a common leak path, and `path` can
    // contain an account number or reference.
    this.#options.onLog(redactObject(event) as LogEvent);
  }
}

/** Pull a human message out of the shapes the Tier 1 providers actually return. */
function extractMessage(body: unknown): string | undefined {
  if (typeof body === "string") return body.slice(0, 500) || undefined;
  if (body === null || typeof body !== "object") return undefined;
  const bag = body as Record<string, unknown>;
  for (const key of ["message", "responseMessage", "error", "detail", "description"]) {
    const value = bag[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

/** Pull a provider error code out, keeping it verbatim for support conversations. */
function extractCode(body: unknown): string | undefined {
  if (body === null || typeof body !== "object") return undefined;
  const bag = body as Record<string, unknown>;
  for (const key of ["code", "responseCode", "errorCode", "error_code", "status"]) {
    const value = bag[key];
    if (typeof value === "string" && value !== "") return value;
    if (typeof value === "number") return String(value);
  }
  return undefined;
}

export { AuthenticationError, ProviderDownError };
