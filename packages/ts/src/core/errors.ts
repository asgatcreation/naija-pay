/**
 * Typed errors.
 *
 * Every call either returns the normalised object or throws one of these. There are no
 * result unions to unwrap, in either language.
 *
 * Two rules hold throughout:
 *
 * 1. The provider's own code and message are always preserved, so a support
 *    conversation with the provider still works.
 * 2. `retryable` is a property of the error, not a judgement the caller has to make.
 *    Getting this wrong is how a payout gets sent twice.
 */

import { redact } from "./redact.ts";

export interface NaijaPayErrorContext {
  /** Which provider adapter raised this, e.g. "paystack". */
  readonly provider?: string;
  /** The naija-pay operation, e.g. "checkout.create". */
  readonly operation?: string;
  /** The provider's own error code, verbatim. */
  readonly providerCode?: string;
  /** The provider's own message, verbatim. Redacted before display. */
  readonly providerMessage?: string;
  readonly httpStatus?: number;
  /** Provider request id, where one is returned — the key to their support tooling. */
  readonly requestId?: string;
  readonly cause?: unknown;
}

export class NaijaPayError extends Error {
  override readonly name: string = "NaijaPayError";

  readonly provider: string | undefined;
  readonly operation: string | undefined;
  readonly providerCode: string | undefined;
  readonly providerMessage: string | undefined;
  readonly httpStatus: number | undefined;
  readonly requestId: string | undefined;

  /**
   * Whether retrying the identical request is safe.
   *
   * Only transport-level and capacity failures are retryable. Nothing that may have
   * already moved money is, regardless of what the HTTP status says.
   */
  readonly retryable: boolean = false;

  constructor(message: string, context: NaijaPayErrorContext = {}) {
    // Redact at construction, so no code path can leak a BVN or key by printing an
    // error. Everything downstream — logs, stack traces, exception reporters — sees
    // the masked form.
    super(redact(message), context.cause === undefined ? undefined : { cause: context.cause });
    this.provider = context.provider;
    this.operation = context.operation;
    this.providerCode = context.providerCode;
    this.providerMessage =
      context.providerMessage === undefined ? undefined : redact(context.providerMessage);
    this.httpStatus = context.httpStatus;
    this.requestId = context.requestId;
  }

  /** Safe to log or serialise: every field has already been redacted. */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      provider: this.provider,
      operation: this.operation,
      providerCode: this.providerCode,
      providerMessage: this.providerMessage,
      httpStatus: this.httpStatus,
      requestId: this.requestId,
      retryable: this.retryable,
    };
  }
}

/** Bad or missing configuration: no key, or a key that contradicts `environment`. */
export class ConfigurationError extends NaijaPayError {
  override readonly name = "ConfigurationError";
}

/** The provider rejected the credentials. Never retried: it will fail identically. */
export class AuthenticationError extends NaijaPayError {
  override readonly name = "AuthenticationError";
}

/** The provider rejected the request shape. */
export class ValidationError extends NaijaPayError {
  override readonly name = "ValidationError";
  /** Per-field messages, where the provider gives them. Field names stay as sent. */
  readonly fields: Readonly<Record<string, string>>;

  constructor(
    message: string,
    context: NaijaPayErrorContext & { fields?: Record<string, string> } = {},
  ) {
    super(message, context);
    const fields: Record<string, string> = {};
    for (const [k, v] of Object.entries(context.fields ?? {})) fields[k] = redact(v);
    this.fields = Object.freeze(fields);
  }
}

/**
 * Identity verification is required or insufficient — a BVN or NIN is needed, or the
 * customer's KYC tier is too low for the operation.
 *
 * This exists as its own type because it is the single most common failure when
 * opening Nigerian virtual accounts, and it is actionable in a way that a generic
 * validation error is not.
 */
export class KycRequiredError extends NaijaPayError {
  override readonly name = "KycRequiredError";
  /** Which identity fields are needed, e.g. ["bvn"]. Never their values. */
  readonly required: readonly string[];
  readonly currentTier: number | undefined;

  constructor(
    message: string,
    context: NaijaPayErrorContext & { required?: string[]; currentTier?: number } = {},
  ) {
    super(message, context);
    this.required = Object.freeze([...(context.required ?? [])]);
    this.currentTier = context.currentTier;
  }
}

export class InsufficientFundsError extends NaijaPayError {
  override readonly name = "InsufficientFundsError";
}

/** The reference has already been used. Means the first request probably succeeded. */
export class DuplicateReferenceError extends NaijaPayError {
  override readonly name = "DuplicateReferenceError";
}

export class NotFoundError extends NaijaPayError {
  override readonly name = "NotFoundError";
}

export class RateLimitedError extends NaijaPayError {
  override readonly name = "RateLimitedError";
  override readonly retryable = true;
  /** Seconds to wait, when the provider says. Flutterwave documents 429 but no value. */
  readonly retryAfterSeconds: number | undefined;

  constructor(message: string, context: NaijaPayErrorContext & { retryAfterSeconds?: number } = {}) {
    super(message, context);
    this.retryAfterSeconds = context.retryAfterSeconds;
  }
}

/** A 5xx, or the circuit breaker refusing to try a provider that is failing. */
export class ProviderDownError extends NaijaPayError {
  override readonly name = "ProviderDownError";
  override readonly retryable = true;
}

/** Timeout, DNS failure, connection reset — the request may never have arrived. */
export class NetworkError extends NaijaPayError {
  override readonly name = "NetworkError";
  override readonly retryable = true;
}

/**
 * A payout, refund or mandate debit whose outcome is genuinely unknown, because the
 * request failed at the transport level after it may already have been accepted.
 *
 * Deliberately **not** retryable. Retrying could pay twice, and no HTTP status can
 * tell us whether the provider acted. The only correct response is to query status by
 * reference, which is what the message says.
 */
export class PayoutStatusUnknownError extends NaijaPayError {
  override readonly name = "PayoutStatusUnknownError";
  override readonly retryable = false;
  readonly reference: string;

  constructor(message: string, context: NaijaPayErrorContext & { reference: string }) {
    super(message, context);
    this.reference = context.reference;
  }
}

/** This provider cannot do this. Thrown locally, before any network call. */
export class UnsupportedOperationError extends NaijaPayError {
  override readonly name = "UnsupportedOperationError";

  constructor(
    context: NaijaPayErrorContext & { provider: string; operation: string; reason?: string },
  ) {
    const reason = context.reason ? ` ${context.reason}` : "";
    super(`${context.provider} does not support ${context.operation}.${reason}`, context);
  }
}

/** A webhook signature did not verify, or could not be verified at all. */
export class WebhookVerificationError extends NaijaPayError {
  override readonly name = "WebhookVerificationError";
}

/** Anything the adapter could not classify. Still carries the provider's own code. */
export class ProviderError extends NaijaPayError {
  override readonly name = "ProviderError";
}

/**
 * Map an HTTP status onto a default error class, for adapters to use as a fallback
 * when a provider's own error code is unrecognised.
 *
 * 409 maps to a duplicate reference because every Tier 1 provider that returns 409
 * does so for a reused reference. Adapters override this from the provider's code.
 */
export function errorClassForStatus(status: number): typeof NaijaPayError {
  if (status === 401 || status === 403) return AuthenticationError;
  if (status === 404) return NotFoundError;
  if (status === 409) return DuplicateReferenceError;
  if (status === 422 || status === 400) return ValidationError;
  if (status === 429) return RateLimitedError;
  if (status >= 500) return ProviderDownError;
  return ProviderError;
}
