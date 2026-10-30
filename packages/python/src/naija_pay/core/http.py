"""The HTTP layer.

The retry, backoff, idempotency and error-mapping logic here is **pure standard
library**. Actually sending bytes is delegated to a ``Transport``, and the httpx-backed
transport is imported lazily in ``naija_pay.core.transport``. That means every risky
path below -- retry decisions above all -- is unit-testable with a fake transport, with
no network and no installs.

The one rule that matters most: **retries are decided by the operation, not by the
error.** A network timeout on a payout looks exactly like a network timeout on a balance
lookup, but retrying the first can pay someone twice. So every request declares its own
safety, and the client refuses to retry anything that might have already moved money --
no matter what the HTTP status says.

Mirrors ``packages/ts/src/core/http.ts``.
"""

from __future__ import annotations

import json
import random as _random
import time
from dataclasses import dataclass, field
from email.utils import parsedate_to_datetime
from typing import Any, Callable, Literal, Mapping, Protocol, Sequence
from urllib.parse import urlencode

from naija_pay.core.errors import (
    NaijaPayError,
    NetworkError,
    PayoutStatusUnknownError,
    RateLimitedError,
    error_class_for_status,
)
from naija_pay.core.redact import redact, redact_object

#: How safe this request is to send more than once.
#:
#: - ``safe``         A read, or a write the provider makes idempotent by reference or
#:                    by an idempotency key. Retried on transport and capacity failures.
#: - ``money-moving`` A payout, refund or mandate debit. **Never retried.** If the
#:                    transport fails the outcome is genuinely unknown, and the caller
#:                    gets ``PayoutStatusUnknownError`` telling them to query by
#:                    reference.
#: - ``unsafe``       Anything else that creates state without a reference we control.
#:                    Not retried, but an ordinary error is raised.
RequestSafety = Literal["safe", "unsafe", "money-moving"]

HttpMethod = Literal["GET", "POST", "PUT", "PATCH", "DELETE"]


@dataclass(frozen=True, slots=True)
class RetryPolicy:
    #: Total attempts, including the first. 1 disables retrying.
    attempts: int = 3
    base_delay_ms: int = 200
    max_delay_ms: int = 4_000


DEFAULT_RETRY_POLICY = RetryPolicy()


@dataclass(frozen=True, slots=True)
class TransportRequest:
    method: str
    url: str
    headers: Mapping[str, str]
    body: str | None
    timeout_seconds: float


@dataclass(frozen=True, slots=True)
class TransportResponse:
    status: int
    headers: Mapping[str, str]
    text: str


class TransportTimeout(Exception):
    """The transport timed out. Raised by transports, mapped to a typed error here."""


class TransportFailure(Exception):
    """A connection-level failure: DNS, reset, TLS. Raised by transports."""


class Transport(Protocol):
    """Anything that can send one HTTP request.

    Keeping this a protocol is what lets the tests drive every retry path without a
    network, and what keeps httpx out of the import graph until a real call is made.
    """

    def send(self, request: TransportRequest) -> TransportResponse: ...


@dataclass(frozen=True, slots=True)
class LogEvent:
    provider: str
    method: str
    #: Path only -- never the query string, which could carry personal data.
    path: str
    attempt: int
    duration_ms: int
    outcome: Literal["success", "retrying", "failed"]
    operation: str | None = None
    status: int | None = None
    error: str | None = None
    request_id: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "provider": self.provider,
            "operation": self.operation,
            "method": self.method,
            "path": self.path,
            "attempt": self.attempt,
            "status": self.status,
            "duration_ms": self.duration_ms,
            "outcome": self.outcome,
            "error": self.error,
            "request_id": self.request_id,
        }


@dataclass(frozen=True, slots=True)
class HttpResponse:
    status: int
    headers: Mapping[str, str]
    body: Any
    #: Raw response text, kept for webhook-adjacent and debugging paths.
    raw: str
    request_id: str | None
    attempts: int


@dataclass
class HttpClientOptions:
    provider: str
    base_url: str
    transport: Transport
    #: Static headers, typically authorization. Redacted before any logging.
    headers: Mapping[str, str] = field(default_factory=dict)
    #: Per-request headers resolved at call time, for token-based auth.
    authorize: Callable[[], Mapping[str, str]] | None = None
    timeout_seconds: float = 30.0
    retry: RetryPolicy = DEFAULT_RETRY_POLICY
    on_log: Callable[[dict[str, Any]], None] | None = None
    #: Injected for tests so backoff does not actually sleep.
    sleep: Callable[[float], None] = time.sleep
    #: Maps a provider's own error payload onto one of our typed errors.
    classify_error: Callable[[int, Any], tuple[type[NaijaPayError], str | None] | None] | None = (
        None
    )
    #: Header carrying the provider's request id, when it has one.
    request_id_header: str | None = None


def _backoff_delay_ms(attempt: int, policy: RetryPolicy, rand: Callable[[], float]) -> int:
    """Full jitter: delay is random in [0, min(max, base * 2^n)]."""
    ceiling = min(policy.max_delay_ms, policy.base_delay_ms * 2 ** (attempt - 1))
    return int(rand() * ceiling)


def _parse_retry_after(value: str | None, now: float) -> int | None:
    """``Retry-After`` may be seconds or an HTTP date; both are documented."""
    if not value:
        return None
    try:
        seconds = float(value)
    except ValueError:
        try:
            when = parsedate_to_datetime(value)
        except (TypeError, ValueError):
            return None
        if when is None:
            return None
        return max(0, int((when.timestamp() - now) * 1_000))
    if seconds >= 0:
        return int(seconds * 1_000)
    return None


def _extract_message(body: Any) -> str | None:
    """Pull a human message out of the shapes the Tier 1 providers actually return."""
    if isinstance(body, str):
        return body[:500] or None
    if not isinstance(body, dict):
        return None
    for key in ("message", "responseMessage", "error", "detail", "description"):
        value = body.get(key)
        if isinstance(value, str) and value != "":
            return value
    return None


def _extract_code(body: Any) -> str | None:
    """Pull a provider error code out, keeping it verbatim for support conversations."""
    if not isinstance(body, dict):
        return None
    for key in ("code", "responseCode", "errorCode", "error_code", "status"):
        value = body.get(key)
        if isinstance(value, str) and value != "":
            return value
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return str(value)
    return None


class HttpClient:
    """Sends requests with retries, idempotency and typed errors.

    The async twin lands with the first adapter in milestone 4; it shares the decision
    helpers in this module rather than duplicating them.
    """

    def __init__(self, options: HttpClientOptions) -> None:
        self._o = options
        #: Overridable only for tests; production always uses random.random.
        self.random: Callable[[], float] = _random.random

    def request(
        self,
        *,
        method: HttpMethod,
        path: str,
        safety: RequestSafety,
        query: Mapping[str, Any] | None = None,
        body: Any = None,
        headers: Mapping[str, str] | None = None,
        operation: str | None = None,
        idempotency_key: str | None = None,
        idempotency_header: str | None = None,
        reference: str | None = None,
    ) -> HttpResponse:
        url = self._build_url(path, query)
        # Only `safe` requests may ever be sent twice.
        max_attempts = max(1, self._o.retry.attempts) if safety == "safe" else 1

        for attempt in range(1, max_attempts + 1):
            started = time.monotonic()
            try:
                response = self._send(
                    method=method,
                    url=url,
                    body=body,
                    headers=headers,
                    idempotency_key=idempotency_key,
                    idempotency_header=idempotency_header,
                )
            except (TransportTimeout, TransportFailure, OSError) as exc:
                duration_ms = int((time.monotonic() - started) * 1_000)
                error = self._transport_error(exc, safety, operation, reference, idempotency_key)
                can_retry = attempt < max_attempts and error.retryable
                self._log(
                    LogEvent(
                        provider=self._o.provider,
                        operation=operation,
                        method=method,
                        path=path,
                        attempt=attempt,
                        duration_ms=duration_ms,
                        outcome="retrying" if can_retry else "failed",
                        error=type(error).__name__,
                    )
                )
                if not can_retry:
                    raise error from exc
                self._sleep_ms(_backoff_delay_ms(attempt, self._o.retry, self.random))
                continue

            duration_ms = int((time.monotonic() - started) * 1_000)
            parsed = self._parse_body(response)
            request_id = self._request_id(response.headers)

            if 200 <= response.status < 300:
                self._log(
                    LogEvent(
                        provider=self._o.provider,
                        operation=operation,
                        method=method,
                        path=path,
                        attempt=attempt,
                        status=response.status,
                        duration_ms=duration_ms,
                        outcome="success",
                        request_id=request_id,
                    )
                )
                return HttpResponse(
                    status=response.status,
                    headers=dict(response.headers),
                    body=parsed,
                    raw=response.text,
                    request_id=request_id,
                    attempts=attempt,
                )

            error = self._response_error(
                response, parsed, safety, operation, reference, idempotency_key, request_id
            )
            can_retry = attempt < max_attempts and error.retryable
            self._log(
                LogEvent(
                    provider=self._o.provider,
                    operation=operation,
                    method=method,
                    path=path,
                    attempt=attempt,
                    status=response.status,
                    duration_ms=duration_ms,
                    outcome="retrying" if can_retry else "failed",
                    error=type(error).__name__,
                    request_id=request_id,
                )
            )
            if not can_retry:
                raise error

            retry_after = (
                _parse_retry_after(response.headers.get("retry-after"), time.time())
                if isinstance(error, RateLimitedError)
                else None
            )
            self._sleep_ms(
                retry_after
                if retry_after is not None
                else _backoff_delay_ms(attempt, self._o.retry, self.random)
            )

        raise NetworkError("request failed with no recorded error")  # pragma: no cover

    # ---------------------------------------------------------------- internals

    def _build_url(self, path: str, query: Mapping[str, Any] | None) -> str:
        base = self._o.base_url.rstrip("/")
        suffix = path if path.startswith("/") else f"/{path}"
        url = base + suffix
        if query:
            pairs: list[tuple[str, str]] = [
                (k, str(v)) for k, v in query.items() if v is not None
            ]
            if pairs:
                url = f"{url}?{urlencode(pairs)}"
        return url

    def _send(
        self,
        *,
        method: str,
        url: str,
        body: Any,
        headers: Mapping[str, str] | None,
        idempotency_key: str | None,
        idempotency_header: str | None,
    ) -> TransportResponse:
        merged: dict[str, str] = {"accept": "application/json"}
        merged.update(self._o.headers)
        if self._o.authorize is not None:
            merged.update(self._o.authorize())
        if headers:
            merged.update(headers)
        if idempotency_key:
            merged[idempotency_header or "x-idempotency-key"] = idempotency_key

        payload: str | None = None
        if body is not None:
            # separators matter: a provider that signs or hashes a body we send must see
            # the same bytes we computed over.
            payload = json.dumps(body, separators=(",", ":"))
            merged["content-type"] = "application/json"

        return self._o.transport.send(
            TransportRequest(
                method=method,
                url=url,
                headers=merged,
                body=payload,
                timeout_seconds=self._o.timeout_seconds,
            )
        )

    @staticmethod
    def _parse_body(response: TransportResponse) -> Any:
        text = response.text
        if text == "":
            return text
        content_type = response.headers.get("content-type", "")
        if "json" in content_type or text.lstrip().startswith("{"):
            try:
                return json.loads(text)
            except json.JSONDecodeError:
                # A provider returning an HTML error page is a real case, and the status
                # code still classifies it correctly.
                return text
        return text

    def _request_id(self, headers: Mapping[str, str]) -> str | None:
        name = self._o.request_id_header
        return headers.get(name.lower()) if name else None

    def _response_error(
        self,
        response: TransportResponse,
        parsed: Any,
        safety: RequestSafety,
        operation: str | None,
        reference: str | None,
        idempotency_key: str | None,
        request_id: str | None,
    ) -> NaijaPayError:
        classified = (
            self._o.classify_error(response.status, parsed) if self._o.classify_error else None
        )
        error_class = classified[0] if classified else error_class_for_status(response.status)
        provider_message = _extract_message(parsed)
        message = (
            (classified[1] if classified and classified[1] else None)
            or provider_message
            or f"{self._o.provider} returned HTTP {response.status}"
        )

        context: dict[str, Any] = {
            "provider": self._o.provider,
            "operation": operation,
            "http_status": response.status,
            "provider_message": provider_message,
            "provider_code": _extract_code(parsed),
            "request_id": request_id,
        }

        if error_class is RateLimitedError:
            retry_after = _parse_retry_after(response.headers.get("retry-after"), time.time())
            return RateLimitedError(
                message,
                retry_after_seconds=None if retry_after is None else -(-retry_after // 1_000),
                **context,
            )

        # A 5xx on a money-moving request is the dangerous case: the provider may well
        # have accepted it. Never report that as retryable.
        if safety == "money-moving" and response.status >= 500:
            return PayoutStatusUnknownError(
                f"{self._o.provider} returned HTTP {response.status} on a money-moving "
                "request. The outcome is unknown and this must NOT be retried blindly "
                "-- query the status by reference instead.",
                reference=reference or idempotency_key or "unknown",
                **context,
            )

        return error_class(message, **context)

    def _transport_error(
        self,
        exc: Exception,
        safety: RequestSafety,
        operation: str | None,
        reference: str | None,
        idempotency_key: str | None,
    ) -> NaijaPayError:
        if isinstance(exc, TransportTimeout):
            what = f"timed out after {self._o.timeout_seconds}s"
        else:
            what = f"failed: {redact(str(exc))}"

        context: dict[str, Any] = {"provider": self._o.provider, "operation": operation}

        # The whole reason `safety` is a required argument: a transport failure on a
        # payout may have been accepted by the provider, so retrying could pay twice.
        if safety == "money-moving":
            return PayoutStatusUnknownError(
                f"the request to {self._o.provider} {what}, on a money-moving request. "
                "The outcome is unknown and this must NOT be retried blindly -- "
                "query the status by reference instead.",
                reference=reference or idempotency_key or "unknown",
                **context,
            )

        return NetworkError(f"the request to {self._o.provider} {what}", **context)

    def _sleep_ms(self, ms: int) -> None:
        self._o.sleep(ms / 1_000)

    def _log(self, event: LogEvent) -> None:
        if self._o.on_log is None:
            return
        # Redacted before it leaves: a log hook is a common leak path, and `path` can
        # contain an account number or reference.
        self._o.on_log(redact_object(event.to_dict()))


__all__: Sequence[str] = [
    "DEFAULT_RETRY_POLICY",
    "HttpClient",
    "HttpClientOptions",
    "HttpMethod",
    "HttpResponse",
    "LogEvent",
    "RequestSafety",
    "RetryPolicy",
    "Transport",
    "TransportFailure",
    "TransportRequest",
    "TransportResponse",
    "TransportTimeout",
]
