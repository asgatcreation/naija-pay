"""Typed errors.

Every call either returns the normalised object or raises one of these. There are no
result unions to unwrap, in either language.

Two rules hold throughout:

1. The provider's own code and message are always preserved, so a support conversation
   with the provider still works.
2. ``retryable`` is a property of the error, not a judgement the caller has to make.
   Getting this wrong is how a payout gets sent twice.

Mirrors ``packages/ts/src/core/errors.ts``; the parity tests assert the two agree.
"""

from __future__ import annotations

from typing import Any

from naija_pay.core.redact import redact


class NaijaPayError(Exception):
    """Base class for every naija-pay error."""

    #: Whether retrying the identical request is safe.
    #:
    #: Only transport-level and capacity failures are retryable. Nothing that may have
    #: already moved money is, regardless of what the HTTP status says.
    retryable: bool = False

    def __init__(
        self,
        message: str,
        *,
        provider: str | None = None,
        operation: str | None = None,
        provider_code: str | None = None,
        provider_message: str | None = None,
        http_status: int | None = None,
        request_id: str | None = None,
    ) -> None:
        # Redact at construction, so no code path can leak a BVN or key by printing an
        # error. Everything downstream -- logs, tracebacks, exception reporters -- sees
        # the masked form.
        super().__init__(redact(message))
        self.message = redact(message)
        self.provider = provider
        self.operation = operation
        self.provider_code = provider_code
        self.provider_message = None if provider_message is None else redact(provider_message)
        self.http_status = http_status
        self.request_id = request_id

    def to_dict(self) -> dict[str, Any]:
        """Safe to log or serialise: every field has already been redacted."""
        return {
            "name": type(self).__name__,
            "message": self.message,
            "provider": self.provider,
            "operation": self.operation,
            "provider_code": self.provider_code,
            "provider_message": self.provider_message,
            "http_status": self.http_status,
            "request_id": self.request_id,
            "retryable": self.retryable,
        }

    def __repr__(self) -> str:
        # Never expose unredacted state through repr, which is what most loggers call.
        return f"{type(self).__name__}({self.message!r})"


class ConfigurationError(NaijaPayError):
    """Bad or missing configuration: no key, or a key that contradicts the environment."""


class AuthenticationError(NaijaPayError):
    """The provider rejected the credentials. Never retried: it will fail identically."""


class ValidationError(NaijaPayError):
    """The provider rejected the request shape."""

    def __init__(
        self, message: str, *, fields: dict[str, str] | None = None, **kwargs: Any
    ) -> None:
        super().__init__(message, **kwargs)
        #: Per-field messages, where the provider gives them. Field names stay as sent.
        self.fields: dict[str, str] = {k: redact(v) for k, v in (fields or {}).items()}


class KycRequiredError(NaijaPayError):
    """Identity verification is required or insufficient.

    This exists as its own type because it is the single most common failure when
    opening Nigerian virtual accounts, and it is actionable in a way that a generic
    validation error is not.
    """

    def __init__(
        self,
        message: str,
        *,
        required: list[str] | None = None,
        current_tier: int | None = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(message, **kwargs)
        #: Which identity fields are needed, e.g. ["bvn"]. Never their values.
        self.required: tuple[str, ...] = tuple(required or ())
        self.current_tier = current_tier


class InsufficientFundsError(NaijaPayError):
    """Not enough balance to complete the operation."""


class DuplicateReferenceError(NaijaPayError):
    """The reference has already been used; the first request probably succeeded."""


class NotFoundError(NaijaPayError):
    """No such resource."""


class RateLimitedError(NaijaPayError):
    """Too many requests."""

    retryable = True

    def __init__(self, message: str, *, retry_after_seconds: int | None = None, **kwargs: Any):
        super().__init__(message, **kwargs)
        #: Seconds to wait, when the provider says. Flutterwave documents 429 but no
        #: value, so this is often None.
        self.retry_after_seconds = retry_after_seconds


class ProviderDownError(NaijaPayError):
    """A 5xx, or the circuit breaker refusing to try a provider that is failing."""

    retryable = True


class NetworkError(NaijaPayError):
    """Timeout, DNS failure, connection reset -- the request may never have arrived."""

    retryable = True


class PayoutStatusUnknownError(NaijaPayError):
    """A payout, refund or mandate debit whose outcome is genuinely unknown.

    Deliberately **not** retryable. Retrying could pay twice, and no HTTP status can
    tell us whether the provider acted. The only correct response is to query status by
    reference.
    """

    retryable = False

    def __init__(self, message: str, *, reference: str, **kwargs: Any) -> None:
        super().__init__(message, **kwargs)
        self.reference = reference


class UnsupportedOperationError(NaijaPayError):
    """This provider cannot do this. Raised locally, before any network call."""

    def __init__(
        self, *, provider: str, operation: str, reason: str | None = None, **kwargs: Any
    ) -> None:
        suffix = f" {reason}" if reason else ""
        super().__init__(
            f"{provider} does not support {operation}.{suffix}",
            provider=provider,
            operation=operation,
            **kwargs,
        )


class WebhookVerificationError(NaijaPayError):
    """A webhook signature did not verify, or could not be verified at all."""


class ProviderError(NaijaPayError):
    """Anything the adapter could not classify. Still carries the provider's own code."""


def error_class_for_status(status: int) -> type[NaijaPayError]:
    """Map an HTTP status onto a default error class.

    For adapters to use as a fallback when a provider's own error code is unrecognised.
    409 maps to a duplicate reference because every Tier 1 provider that returns 409
    does so for a reused reference. Adapters override this from the provider's code.
    """
    if status in (401, 403):
        return AuthenticationError
    if status == 404:
        return NotFoundError
    if status == 409:
        return DuplicateReferenceError
    if status in (400, 422):
        return ValidationError
    if status == 429:
        return RateLimitedError
    if status >= 500:
        return ProviderDownError
    return ProviderError
