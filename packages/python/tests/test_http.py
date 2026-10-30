"""HTTP layer tests, mirroring packages/ts/test/http.test.ts.

Everything here runs against a fake transport, so there is no network and nothing to
install -- which is the reason the retry logic lives in pure stdlib behind a Transport
protocol in the first place.
"""

import json
import pathlib
import sys
import unittest
from typing import Any

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "src"))

from naija_pay.core.errors import (  # noqa: E402
    AuthenticationError,
    DuplicateReferenceError,
    InsufficientFundsError,
    NetworkError,
    NotFoundError,
    PayoutStatusUnknownError,
    ProviderDownError,
    RateLimitedError,
    ValidationError,
)
from naija_pay.core.http import (  # noqa: E402
    HttpClient,
    HttpClientOptions,
    RetryPolicy,
    TransportFailure,
    TransportRequest,
    TransportResponse,
    TransportTimeout,
)


class FakeTransport:
    """Replays the given responses in order; an Exception instance is raised instead."""

    def __init__(self, responses: list[Any]) -> None:
        self.responses = responses
        self.requests: list[TransportRequest] = []

    def send(self, request: TransportRequest) -> TransportResponse:
        self.requests.append(request)
        index = min(len(self.requests) - 1, len(self.responses) - 1)
        nxt = self.responses[index]
        if isinstance(nxt, Exception):
            raise nxt
        status, body, headers = nxt
        text = body if isinstance(body, str) else json.dumps(body)
        merged = {"content-type": "application/json"}
        merged.update(headers or {})
        return TransportResponse(status=status, headers=merged, text=text)

    @property
    def attempts(self) -> int:
        return len(self.requests)


def make_client(transport: FakeTransport, **overrides: Any) -> tuple[HttpClient, list[float]]:
    slept: list[float] = []
    options = HttpClientOptions(
        provider="testprovider",
        base_url="https://api.test.example/v1",
        transport=transport,
        headers={"authorization": "Bearer sk_test_EXAMPLE123"},
        sleep=slept.append,
        request_id_header="x-request-id",
        **overrides,
    )
    client = HttpClient(options)
    client.random = lambda: 0.5
    return client, slept


def ok(body: Any = None) -> tuple[int, Any, dict[str, str] | None]:
    return (200, body if body is not None else {}, None)


class TestRetryingSafeRequests(unittest.TestCase):
    def test_retries_503_then_succeeds(self) -> None:
        t = FakeTransport([(503, {}, None), (503, {}, None), ok({"ok": True})])
        client, slept = make_client(t)

        response = client.request(method="GET", path="/transaction", safety="safe")

        self.assertEqual(response.status, 200)
        self.assertEqual(response.attempts, 3)
        self.assertEqual(t.attempts, 3)
        self.assertEqual(len(slept), 2)
        self.assertGreaterEqual(slept[1], slept[0])

    def test_gives_up_after_configured_attempts(self) -> None:
        t = FakeTransport([(503, {}, None)])
        client, _ = make_client(t, retry=RetryPolicy(attempts=2, base_delay_ms=1, max_delay_ms=2))

        with self.assertRaises(ProviderDownError):
            client.request(method="GET", path="/x", safety="safe")
        self.assertEqual(t.attempts, 2)

    def test_does_not_retry_non_retryable(self) -> None:
        t = FakeTransport([(400, {"message": "amount is required"}, None)])
        client, _ = make_client(t)

        with self.assertRaises(ValidationError):
            client.request(method="GET", path="/x", safety="safe")
        self.assertEqual(t.attempts, 1)

    def test_honours_retry_after(self) -> None:
        t = FakeTransport([(429, {}, {"retry-after": "2"}), ok()])
        client, slept = make_client(t)

        client.request(method="GET", path="/x", safety="safe")
        self.assertEqual(slept, [2.0])

    def test_retries_transport_failure(self) -> None:
        t = FakeTransport([TransportFailure("connection reset"), ok()])
        client, _ = make_client(t)

        response = client.request(method="GET", path="/x", safety="safe")
        self.assertEqual(response.attempts, 2)

    def test_retries_timeout(self) -> None:
        t = FakeTransport([TransportTimeout("too slow"), ok()])
        client, _ = make_client(t)

        self.assertEqual(client.request(method="GET", path="/x", safety="safe").attempts, 2)


class TestMoneyMovingNeverRetried(unittest.TestCase):
    def test_503_becomes_payout_status_unknown(self) -> None:
        t = FakeTransport([(503, {}, None), ok({"ok": True})])
        client, _ = make_client(t)

        with self.assertRaises(PayoutStatusUnknownError) as ctx:
            client.request(
                method="POST",
                path="/transfer",
                safety="money-moving",
                reference="payout_01HQ",
                body={"amount": 500},
            )

        error = ctx.exception
        self.assertFalse(error.retryable, "retrying a payout could pay twice")
        self.assertEqual(error.reference, "payout_01HQ")
        self.assertIn("must NOT be retried", str(error))
        self.assertIn("query the status by reference", str(error))
        self.assertEqual(t.attempts, 1, "the payout must be sent exactly once")

    def test_transport_failure_becomes_payout_status_unknown(self) -> None:
        t = FakeTransport([TransportFailure("socket hang up")])
        client, _ = make_client(t)

        with self.assertRaises(PayoutStatusUnknownError) as ctx:
            client.request(
                method="POST", path="/transfer", safety="money-moving", reference="payout_01HQ"
            )
        self.assertEqual(ctx.exception.reference, "payout_01HQ")
        self.assertEqual(t.attempts, 1)

    def test_falls_back_to_idempotency_key_as_reference(self) -> None:
        t = FakeTransport([TransportFailure("boom")])
        client, _ = make_client(t)

        with self.assertRaises(PayoutStatusUnknownError) as ctx:
            client.request(
                method="POST", path="/transfer", safety="money-moving", idempotency_key="idem_123"
            )
        self.assertEqual(ctx.exception.reference, "idem_123")

    def test_4xx_on_money_moving_is_an_ordinary_typed_error(self) -> None:
        # A rejected payout definitely did not happen, so it is safe to report plainly.
        t = FakeTransport([(400, {"message": "insufficient balance"}, None)])
        client, _ = make_client(
            t,
            classify_error=lambda status, body: (
                (InsufficientFundsError, None) if status == 400 else None
            ),
        )

        with self.assertRaises(InsufficientFundsError):
            client.request(method="POST", path="/transfer", safety="money-moving", reference="p1")


class TestUnsafeRequests(unittest.TestCase):
    def test_not_retried_but_ordinary_network_error(self) -> None:
        t = FakeTransport([TransportFailure("connection reset")])
        client, _ = make_client(t)

        with self.assertRaises(NetworkError):
            client.request(method="POST", path="/customer", safety="unsafe")
        self.assertEqual(t.attempts, 1)


class TestErrorClassification(unittest.TestCase):
    def test_maps_statuses(self) -> None:
        cases = [
            (401, AuthenticationError),
            (404, NotFoundError),
            (409, DuplicateReferenceError),
            (422, ValidationError),
            (429, RateLimitedError),
            (502, ProviderDownError),
        ]
        for status, expected in cases:
            t = FakeTransport([(status, {}, None)])
            client, _ = make_client(
                t, retry=RetryPolicy(attempts=1, base_delay_ms=1, max_delay_ms=1)
            )
            with self.assertRaises(expected, msg=f"status {status}"):
                client.request(method="GET", path="/x", safety="safe")

    def test_keeps_provider_message_and_code(self) -> None:
        t = FakeTransport([(400, {"message": "Invalid account number", "code": "invalid_account"}, None)])
        client, _ = make_client(t)

        with self.assertRaises(ValidationError) as ctx:
            client.request(
                method="GET", path="/x", safety="safe", operation="banks.resolveAccount"
            )
        error = ctx.exception
        self.assertEqual(error.provider_message, "Invalid account number")
        self.assertEqual(error.provider_code, "invalid_account")
        self.assertEqual(error.provider, "testprovider")
        self.assertEqual(error.operation, "banks.resolveAccount")
        self.assertEqual(error.http_status, 400)

    def test_adapter_classifier_overrides_status(self) -> None:
        t = FakeTransport([(400, {"code": "duplicate_reference"}, None)])
        client, _ = make_client(
            t,
            classify_error=lambda status, body: (
                (DuplicateReferenceError, "reference already used")
                if isinstance(body, dict) and body.get("code") == "duplicate_reference"
                else None
            ),
        )

        with self.assertRaises(DuplicateReferenceError) as ctx:
            client.request(method="GET", path="/x", safety="safe")
        self.assertEqual(str(ctx.exception), "reference already used")

    def test_survives_html_instead_of_json(self) -> None:
        t = FakeTransport(
            [(502, "<html><body>Bad Gateway</body></html>", {"content-type": "text/html"})]
        )
        client, _ = make_client(t, retry=RetryPolicy(attempts=1, base_delay_ms=1, max_delay_ms=1))

        with self.assertRaises(ProviderDownError):
            client.request(method="GET", path="/x", safety="safe")

    def test_captures_request_id(self) -> None:
        t = FakeTransport([(404, {}, {"x-request-id": "req_abc123"})])
        client, _ = make_client(t)

        with self.assertRaises(NotFoundError) as ctx:
            client.request(method="GET", path="/x", safety="safe")
        self.assertEqual(ctx.exception.request_id, "req_abc123")


class TestRequestConstruction(unittest.TestCase):
    def test_builds_url_with_query_skipping_none(self) -> None:
        t = FakeTransport([ok()])
        client, _ = make_client(t)

        client.request(
            method="GET",
            path="transaction",
            query={"page": 1, "status": "success", "from": None},
            safety="safe",
        )

        url = t.requests[0].url
        self.assertIn("/v1/transaction?", url)
        self.assertIn("page=1", url)
        self.assertIn("status=success", url)
        self.assertNotIn("from=", url)

    def test_sends_idempotency_key_under_provider_header(self) -> None:
        t = FakeTransport([ok()])
        client, _ = make_client(t)

        client.request(
            method="POST",
            path="/charge",
            safety="safe",
            idempotency_key="idem_123",
            idempotency_header="X-Idempotency-Key",
            body={"amount": 500},
        )

        request = t.requests[0]
        self.assertEqual(request.headers["X-Idempotency-Key"], "idem_123")
        self.assertEqual(request.headers["content-type"], "application/json")
        self.assertEqual(request.body, '{"amount":500}')

    def test_resolves_per_request_auth_headers(self) -> None:
        t = FakeTransport([ok()])
        calls = []

        def authorize() -> dict[str, str]:
            calls.append(1)
            return {"authorization": "Bearer token-from-oauth"}

        client, _ = make_client(t, authorize=authorize)
        client.request(method="GET", path="/x", safety="safe")

        self.assertEqual(t.requests[0].headers["authorization"], "Bearer token-from-oauth")
        self.assertEqual(len(calls), 1)


class TestLogging(unittest.TestCase):
    def test_never_leaks_credentials_or_identifiers(self) -> None:
        t = FakeTransport([ok()])
        events: list[dict] = []
        client, _ = make_client(t, on_log=events.append)

        client.request(
            method="GET",
            path="/dedicated_account/0123456789",
            safety="safe",
            operation="virtualAccounts.get",
        )

        self.assertEqual(len(events), 1)
        serialised = json.dumps(events)
        self.assertNotIn("sk_test_EXAMPLE123", serialised)
        self.assertNotIn("0123456789", serialised)
        self.assertEqual(events[0]["outcome"], "success")
        self.assertEqual(events[0]["operation"], "virtualAccounts.get")

    def test_records_each_attempt(self) -> None:
        t = FakeTransport([(503, {}, None), ok()])
        events: list[dict] = []
        client, _ = make_client(t, on_log=events.append)

        client.request(method="GET", path="/x", safety="safe")

        self.assertEqual(len(events), 2)
        self.assertEqual(events[0]["outcome"], "retrying")
        self.assertEqual(events[0]["attempt"], 1)
        self.assertEqual(events[1]["outcome"], "success")
        self.assertEqual(events[1]["attempt"], 2)


class TestTransportModuleStaysLazy(unittest.TestCase):
    def test_importing_the_core_does_not_require_httpx(self) -> None:
        # The whole reason the retry logic sits behind a Transport protocol: these
        # modules must import with nothing installed.
        self.assertNotIn("httpx", sys.modules, "httpx was imported by naija_pay.core")


if __name__ == "__main__":
    unittest.main()
