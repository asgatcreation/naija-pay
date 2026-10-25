/**
 * naija-pay — one typed interface to every Nigerian payment and
 * banking-as-a-service provider.
 *
 * The API contract being built to is in DESIGN.md at the repository root.
 * Provider adapters live behind their own entry points (`naija-pay/paystack` and so
 * on) so that an application only bundles the providers it imports.
 */

export {
  BASIS_POINTS_TOTAL,
  type Currency,
  type Money,
  MoneyError,
  type Share,
  type SplitPart,
  type SplitResult,
  add,
  compare,
  equals,
  format,
  fromMajor,
  isZero,
  minorUnitExponent,
  money,
  naira,
  splitByBasisPoints,
  splitByFlatAmounts,
  subtract,
} from "./core/money.ts";

export {
  AuthenticationError,
  ConfigurationError,
  DuplicateReferenceError,
  InsufficientFundsError,
  KycRequiredError,
  NaijaPayError,
  type NaijaPayErrorContext,
  NetworkError,
  NotFoundError,
  PayoutStatusUnknownError,
  ProviderDownError,
  ProviderError,
  RateLimitedError,
  UnsupportedOperationError,
  ValidationError,
  WebhookVerificationError,
  errorClassForStatus,
} from "./core/errors.ts";

export {
  looksLikeLiveKey,
  looksLikeTestKey,
  maskAccountNumber,
  maskIdentityNumber,
  redact,
  redactObject,
} from "./core/redact.ts";

/** The package version. Kept identical to the Python package; CI enforces it. */
export const VERSION = "0.0.0";

/**
 * Environments a client can be configured for. A provider's key prefix is checked
 * against this, because several providers use the same host for test and live.
 */
export type Environment = "test" | "live";

/**
 * How strongly a received webhook was actually verified.
 *
 * Providers differ enormously here — see the webhook table in PROVIDERS.md. Rather
 * than pretending they are equivalent, every parsed event reports which of these it
 * earned, so an application can refuse to act on a weak one.
 *
 * - `full-body`      HMAC over the whole raw body (Paystack, Flutterwave v4)
 * - `partial-body`   HMAC over only part of the payload (Korapay signs `data` only,
 *                    leaving the event name unauthenticated)
 * - `shared-secret`  a secret was presented but nothing binds it to the payload, so
 *                    there is no integrity and no replay protection (Flutterwave v3)
 * - `unverified`     the provider's scheme is undocumented, or verification was
 *                    explicitly skipped (Squad and Monnify, as of 2026-10-25)
 */
export type SignatureStrength =
  | "full-body"
  | "partial-body"
  | "shared-secret"
  | "unverified";
