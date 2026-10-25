"""naija-pay — one typed interface to every Nigerian payment and banking-as-a-service provider.

The API contract being built to is in DESIGN.md at the repository root.
"""

from typing import Literal

from naija_pay.core import (
    BASIS_POINTS_TOTAL,
    AuthenticationError,
    ConfigurationError,
    DuplicateReferenceError,
    InsufficientFundsError,
    KycRequiredError,
    Money,
    MoneyError,
    NaijaPayError,
    NetworkError,
    NotFoundError,
    PayoutStatusUnknownError,
    ProviderDownError,
    ProviderError,
    RateLimitedError,
    Share,
    SplitPart,
    SplitResult,
    UnsupportedOperationError,
    ValidationError,
    WebhookVerificationError,
    add,
    compare,
    error_class_for_status,
    format_money,
    from_major,
    looks_like_live_key,
    looks_like_test_key,
    mask_account_number,
    mask_identity_number,
    minor_unit_exponent,
    money,
    naira,
    redact,
    redact_object,
    split_by_basis_points,
    split_by_flat_amounts,
    subtract,
)

#: The package version. Kept identical to the TypeScript package; CI enforces it.
__version__ = "0.0.0"

#: Environments a client can be configured for. A provider's key prefix is checked
#: against this, because several providers use the same host for test and live.
Environment = Literal["test", "live"]

#: How strongly a received webhook was actually verified.
#:
#: Providers differ enormously here — see the webhook table in PROVIDERS.md. Rather
#: than pretending they are equivalent, every parsed event reports which of these it
#: earned, so an application can refuse to act on a weak one.
#:
#: - ``full-body``     HMAC over the whole raw body (Paystack, Flutterwave v4)
#: - ``partial-body``  HMAC over only part of the payload (Korapay signs ``data``
#:                     only, leaving the event name unauthenticated)
#: - ``shared-secret`` a secret was presented but nothing binds it to the payload,
#:                     so there is no integrity and no replay protection
#:                     (Flutterwave v3)
#: - ``unverified``    the provider's scheme is undocumented, or verification was
#:                     explicitly skipped (Squad and Monnify, as of 2026-10-25)
SignatureStrength = Literal["full-body", "partial-body", "shared-secret", "unverified"]

__all__ = [
    "BASIS_POINTS_TOTAL",
    "AuthenticationError",
    "ConfigurationError",
    "DuplicateReferenceError",
    "Environment",
    "InsufficientFundsError",
    "KycRequiredError",
    "Money",
    "MoneyError",
    "NaijaPayError",
    "NetworkError",
    "NotFoundError",
    "PayoutStatusUnknownError",
    "ProviderDownError",
    "ProviderError",
    "RateLimitedError",
    "Share",
    "SignatureStrength",
    "SplitPart",
    "SplitResult",
    "UnsupportedOperationError",
    "ValidationError",
    "WebhookVerificationError",
    "__version__",
    "add",
    "compare",
    "error_class_for_status",
    "format_money",
    "from_major",
    "looks_like_live_key",
    "looks_like_test_key",
    "mask_account_number",
    "mask_identity_number",
    "minor_unit_exponent",
    "money",
    "naira",
    "redact",
    "redact_object",
    "split_by_basis_points",
    "split_by_flat_amounts",
    "subtract",
]
