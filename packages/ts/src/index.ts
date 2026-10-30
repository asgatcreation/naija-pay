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

export {
  SCHEMES,
  type HashAlgorithm,
  type SignatureKind,
  type SignatureScheme,
  type SignatureStrength,
  type VerificationResult,
  computeSignature,
  constantTimeEqual,
  strengthOf,
  verifySignature,
} from "./core/signatures.ts";

export {
  type Channel,
  type Operation,
  type OperationSupport,
  type ProviderCapabilities,
  assertSupported,
  operationsNotSandboxVerified,
  operationsRequiringApproval,
  requiredKycFor,
  supportFor,
  supports,
} from "./core/capabilities.ts";

export {
  DEFAULT_RETRY_POLICY,
  HttpClient,
  type HttpClientOptions,
  type HttpResponse,
  type LogEvent,
  type RequestOptions,
  type RequestSafety,
  type RetryPolicy,
} from "./core/http.ts";
