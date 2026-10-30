/**
 * naija-pay — one typed interface to every Nigerian payment and
 * banking-as-a-service provider.
 *
 * The API contract being built to is in DESIGN.md at the repository root.
 * Provider adapters live behind their own entry points (`naija-pay/paystack` and so
 * on) so that an application only bundles the providers it imports.
 */

export {
  AuthenticationError,
  ConfigurationError,
  DuplicateReferenceError,
  errorClassForStatus,
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
} from "./core/errors.ts";
export {
  add,
  BASIS_POINTS_TOTAL,
  type Currency,
  compare,
  equals,
  format,
  fromMajor,
  isZero,
  type Money,
  MoneyError,
  minorUnitExponent,
  money,
  naira,
  type Share,
  type SplitPart,
  type SplitResult,
  splitByBasisPoints,
  splitByFlatAmounts,
  subtract,
} from "./core/money.ts";

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

// Bank matching is NOT re-exported here on purpose. It carries the naija-data
// institution registry, which is ~20 KB gzipped, and an application that only needs
// money helpers, typed errors or webhook verification should not pay for it. Import
// it from "naija-pay/banks" instead; the provider adapters pull it in themselves.

export {
  assertSupported,
  type Channel,
  type Operation,
  type OperationSupport,
  operationsNotSandboxVerified,
  operationsRequiringApproval,
  type ProviderCapabilities,
  requiredKycFor,
  supportFor,
  supports,
} from "./core/capabilities.ts";
export {
  classifyInflow,
  DEFAULT_INFLOW_RULES,
  decideInflow,
  type EventSender,
  type EventType,
  hasProcessed,
  type IdempotencyStore,
  type InflowDecision,
  type InflowRules,
  type InflowVariance,
  type LatePaymentAction,
  memoryStore,
  type NaijaPayEvent,
  type OverpaymentAction,
  type UnderpaymentAction,
  type VirtualAccountInflow,
} from "./core/events.ts";
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
export {
  computeSignature,
  constantTimeEqual,
  type HashAlgorithm,
  SCHEMES,
  type SignatureKind,
  type SignatureScheme,
  type SignatureStrength,
  strengthOf,
  type VerificationResult,
  verifySignature,
} from "./core/signatures.ts";
