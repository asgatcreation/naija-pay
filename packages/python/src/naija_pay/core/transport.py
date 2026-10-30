"""The httpx-backed transport.

Kept in its own module, and ``httpx`` is imported inside the constructor rather than at
module level. Two reasons:

1. ``naija_pay.core.http`` -- where every retry, backoff and idempotency decision lives
   -- stays pure standard library, so those paths are unit-testable with a fake
   transport, offline and with nothing installed.
2. Importing ``naija_pay`` does not require httpx to be present until a real request is
   actually made, which keeps the import cost off anyone only using the money, error or
   webhook helpers.
"""

from __future__ import annotations

from typing import Any

from naija_pay.core.http import (
    TransportError,
    TransportRequest,
    TransportResponse,
    TransportTimeoutError,
)


class HttpxTransport:
    """Sends requests with httpx. The default transport for every adapter."""

    def __init__(self, client: Any | None = None) -> None:
        try:
            import httpx
        except ModuleNotFoundError as exc:  # pragma: no cover - depends on environment
            raise ModuleNotFoundError(
                "naija-pay needs httpx to make real HTTP requests. "
                "Install it with `pip install naija-pay`, which pulls it in, or pass "
                "your own Transport if you are supplying the HTTP layer yourself."
            ) from exc

        self._httpx = httpx
        # A caller-supplied client lets an application share connection pooling, set
        # proxies, or pin TLS settings, without naija-pay growing options for each.
        self._client = client

    def send(self, request: TransportRequest) -> TransportResponse:
        httpx = self._httpx
        client = self._client
        owns_client = client is None
        if client is None:
            client = httpx.Client()

        try:
            response = client.request(
                request.method,
                request.url,
                headers=dict(request.headers),
                content=request.body,
                timeout=request.timeout_seconds,
            )
        except httpx.TimeoutException as exc:
            raise TransportTimeoutError(str(exc)) from exc
        except httpx.HTTPError as exc:
            # Connection errors, DNS failures, TLS problems, protocol errors.
            raise TransportError(str(exc)) from exc
        finally:
            if owns_client:
                client.close()

        return TransportResponse(
            status=response.status_code,
            headers={k.lower(): v for k, v in response.headers.items()},
            text=response.text,
        )


__all__ = ["HttpxTransport"]
