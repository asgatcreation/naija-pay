"""The mock provider.

A developer should be able to build and test an entire pay-by-transfer flow -- including
signature verification and the awkward cases -- **before** they have any provider account
at all. That is what this is for.

It signs the webhooks it emits with a real scheme, so the same verification code that
runs in production runs here. Nothing is stubbed out on the security path.

Every edge case from PROVIDERS.md is reachable: overpayment, underpayment, payment after
expiry, duplicate delivery, reversal, and a deliberately invalid signature.

Mirrors ``packages/ts/src/providers/mock/index.ts``.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from naija_pay.core.capabilities import (
    OperationSupport,
    ProviderCapabilities,
    WebhookSignature,
)
from naija_pay.core.events import (
    EventSender,
    NaijaPayEvent,
    VirtualAccountInflow,
    classify_inflow,
)
from naija_pay.core.money import Money, naira
from naija_pay.core.signatures import SignatureScheme, compute_signature

MOCK_PROVIDER_NAME = "mock"

#: The mock's default signing secret.
#:
#: Public on purpose: it is a mock, and a developer should be able to verify its webhooks
#: without configuring anything. It contains EXAMPLE so the repository's live-key scan
#: ignores it.
MOCK_DEFAULT_SECRET = "sk_test_EXAMPLEmocksecret"

#: The mock signs with Paystack's scheme -- HMAC-SHA512 hex over the raw body -- because
#: it is the strongest of the Tier 1 schemes, so code written against the mock works
#: unchanged against the strictest real provider.
MOCK_SCHEME = SignatureScheme(
    kind="hmac-hex",
    header="x-mock-signature",
    algorithm="SHA-512",
    strength="full-body",
)

_ALL_OPERATIONS: tuple[str, ...] = (
    "checkout.create",
    "transactions.verify",
    "transactions.list",
    "refunds.create",
    "refunds.status",
    "virtualAccounts.createStatic",
    "virtualAccounts.createDynamic",
    "virtualAccounts.get",
    "virtualAccounts.list",
    "virtualAccounts.updateKyc",
    "virtualAccounts.deactivate",
    "virtualAccounts.listInflows",
    "splitAccounts.create",
    "splitAccounts.update",
    "splitAccounts.list",
    "splitAccounts.deactivate",
    "splits.create",
    "splits.update",
    "splits.list",
    "splits.settlements",
    "wallets.onboardCustomer",
    "wallets.open",
    "wallets.balance",
    "wallets.statement",
    "wallets.transfer",
    "wallets.freeze",
    "wallets.unfreeze",
    "wallets.close",
    "payouts.create",
    "payouts.createBulk",
    "payouts.status",
    "banks.list",
    "banks.resolveAccount",
    "balance.get",
    "plans.create",
    "subscriptions.create",
    "charges.chargeAuthorization",
    "mandates.create",
    "mandates.status",
    "mandates.debit",
    "mandates.cancel",
    "identity.verifyBvn",
    "identity.verifyNin",
    "webhooks.verify",
)

_CHANNELS = (
    "card",
    "bank_transfer",
    "ussd",
    "bank_account",
    "qr",
    "wallet",
    "mobile_money",
)

#: The mock supports everything, so a developer can exercise the whole normalised API.
#: It is the only provider for which that is true, and the capability matrix labels it as
#: a testing tool rather than a real provider.
mock_capabilities = ProviderCapabilities(
    provider=MOCK_PROVIDER_NAME,
    operations={
        operation: (
            OperationSupport(
                required_kyc=("bvn",),
                notes="Mirrors the real providers, which require a BVN.",
            )
            if operation == "virtualAccounts.createStatic"
            else OperationSupport()
        )
        for operation in _ALL_OPERATIONS
    },
    channels=_CHANNELS,
    currencies=("NGN", "GHS", "KES", "ZAR", "USD", "XOF"),
    webhook_signature=WebhookSignature(
        strength="full-body",
        header=MOCK_SCHEME.header,
        algorithm="HMAC-SHA512 hex over the raw body",
        notes="Matches Paystack's scheme, the strongest of the Tier 1 providers.",
    ),
)


@dataclass(frozen=True, slots=True)
class MockWebhook:
    """A signed webhook, ready to post at an endpoint or hand straight to a parser."""

    #: The raw bytes to deliver. Verification must use exactly these.
    body: bytes
    headers: Mapping[str, str]
    #: The normalised event the body represents, for assertions in tests.
    event: NaijaPayEvent
    #: The JSON text of the body, for logging and snapshots.
    text: str


def _money_json(amount: Money | None) -> dict[str, Any] | None:
    """Money on the wire, in the shape both languages emit."""
    return None if amount is None else {"amount": amount.amount, "currency": amount.currency}


def _iso_millis(when: datetime) -> str:
    """ISO 8601 in UTC with millisecond precision, matching JavaScript's toISOString.

    The mock's wire format must be byte-identical across both languages so a fixture
    recorded from it drives either test suite. Python's ``isoformat`` gives microseconds
    or none at all, so the format is pinned explicitly here.
    """
    utc = when.astimezone(timezone.utc)
    return f"{utc.strftime('%Y-%m-%dT%H:%M:%S')}.{utc.microsecond // 1000:03d}Z"


class MockProvider:
    """Builds signed webhooks for every normalised event, with no keys and no network."""

    def __init__(
        self,
        *,
        secret: str = MOCK_DEFAULT_SECRET,
        scheme: SignatureScheme = MOCK_SCHEME,
        now: Callable[[], datetime] | None = None,
        id_prefix: str = "evt_mock",
    ) -> None:
        self.capabilities = mock_capabilities
        self.secret = secret
        self.scheme = scheme
        self._now = now or (lambda: datetime.now(timezone.utc))
        self._id_prefix = id_prefix
        self._counter = 0

    def next_event_id(self) -> str:
        """Deterministic event ids, so a duplicate can be produced on purpose."""
        self._counter += 1
        return f"{self._id_prefix}_{self._counter:04d}"

    def build_webhook(
        self,
        *,
        event_type: str,
        data: Any,
        event_id: str | None = None,
        occurred_at: datetime | None = None,
        invalid_signature: bool = False,
    ) -> MockWebhook:
        """Build and sign a webhook for any normalised event type.

        The body is the normalised event itself, which is what makes the mock readable:
        a developer can see exactly what their handler will receive.
        """
        when = occurred_at or self._now()
        identifier = event_id or self.next_event_id()

        payload = {
            "id": identifier,
            "event": event_type,
            "occurred_at": _iso_millis(when),
            "provider": MOCK_PROVIDER_NAME,
            "data": data,
        }

        text = json.dumps(payload, separators=(",", ":"))
        body = text.encode("utf-8")

        signature = (
            # Deliberately wrong, and obviously so if it ever shows up in a log.
            "0" * 128 if invalid_signature else compute_signature(self.scheme, body, self.secret)
        )
        strength = "unverified" if invalid_signature else self.scheme.strength

        return MockWebhook(
            body=body,
            text=text,
            headers={"content-type": "application/json", self.scheme.header: signature},
            event=NaijaPayEvent(
                id=identifier,
                type=event_type,  # type: ignore[arg-type]
                occurred_at=when,
                provider=MOCK_PROVIDER_NAME,
                signature_strength=strength,
                data=data,
                raw=payload,
                provider_event=event_type,
            ),
        )

    def simulate_inflow(
        self,
        *,
        amount_paid: Money,
        expected_amount: Money | None = None,
        account_number: str = "0123456789",
        reference: str | None = None,
        paid_at: datetime | None = None,
        expires_at: datetime | None = None,
        sender: EventSender | None = None,
        fees: Money | None = None,
        session_id: str | None = None,
        invalid_signature: bool = False,
    ) -> MockWebhook:
        """Simulate money arriving in a virtual account.

        The variance and lateness are computed by the same ``classify_inflow`` the real
        adapters use, so a test cannot accidentally assert against a different rule than
        production applies.
        """
        when = paid_at or self._now()
        classification = classify_inflow(
            expected_amount=expected_amount,
            amount_paid=amount_paid,
            paid_at=when,
            expires_at=expires_at,
        )

        inflow = VirtualAccountInflow(
            reference=reference or f"inflow_mock_{self._counter + 1:04d}",
            # An obviously fake NUBAN, and one the redactor will mask in logs.
            account_number=account_number,
            expected_amount=expected_amount,
            amount_paid=amount_paid,
            fees=fees,
            settled_amount=None,
            sender=sender
            or EventSender(name="ADA OBI", bank="Access Bank", account_number="9876543210"),
            session_id=session_id,
            paid_at=when,
            expires_at=expires_at,
            variance=classification.variance,
            variance_amount=classification.variance_amount,
            is_late=classification.is_late,
        )

        return self.build_webhook(
            event_type="virtual_account.credited",
            data={
                "reference": inflow.reference,
                "account_number": inflow.account_number,
                "expected_amount": _money_json(inflow.expected_amount),
                "amount_paid": _money_json(inflow.amount_paid),
                "fees": _money_json(inflow.fees),
                "variance": inflow.variance,
                "variance_amount": _money_json(inflow.variance_amount),
                "is_late": inflow.is_late,
                "sender": {
                    "name": inflow.sender.name if inflow.sender else None,
                    "bank": inflow.sender.bank if inflow.sender else None,
                    "account_number": inflow.sender.account_number if inflow.sender else None,
                },
                "session_id": inflow.session_id,
            },
            occurred_at=when,
            invalid_signature=invalid_signature,
        )

    def simulate_payment(
        self,
        *,
        status: str,
        amount: Money | None = None,
        reference: str = "order_mock_0001",
        invalid_signature: bool = False,
    ) -> MockWebhook:
        """Simulate a collection reaching a terminal state."""
        return self.build_webhook(
            event_type=f"payment.{status}",
            data={
                "reference": reference,
                "status": status,
                "amount": _money_json(amount or naira(5_000)),
                "channel": "bank_transfer",
            },
            invalid_signature=invalid_signature,
        )

    def simulate_transfer(
        self,
        *,
        status: str,
        amount: Money | None = None,
        reference: str = "payout_mock_0001",
    ) -> MockWebhook:
        """Simulate a payout reaching a terminal state, including a reversal."""
        return self.build_webhook(
            event_type=f"transfer.{status}",
            data={
                "reference": reference,
                "status": status,
                "amount": _money_json(amount or naira(25_000)),
                "recipient": {
                    "bank_code": "044",
                    "account_number": "0123456789",
                    "name": "ADA OBI",
                },
            },
        )


def mock(**options: Any) -> MockProvider:
    """Create a mock provider. Takes no keys, and reaches no network."""
    return MockProvider(**options)


#: Every inflow edge case, as a ready-made scenario set.
#:
#: Exported so a developer can loop over the awkward cases in their own test suite
#: instead of having to think of them. These are exactly the cases PROVIDERS.md says each
#: provider leaves to you.
INFLOW_SCENARIOS: Sequence[dict[str, Any]] = (
    {
        "name": "exact payment",
        "expected_variance": "exact",
        "options": {"expected_amount": naira(5_000), "amount_paid": naira(5_000)},
    },
    {
        "name": "overpayment",
        "expected_variance": "overpayment",
        "options": {"expected_amount": naira(5_000), "amount_paid": naira(5_500)},
    },
    {
        "name": "underpayment",
        "expected_variance": "underpayment",
        "options": {"expected_amount": naira(5_000), "amount_paid": naira(4_900)},
    },
    {
        "name": "static account funding, no expected amount",
        "expected_variance": "unexpected",
        "options": {"expected_amount": None, "amount_paid": naira(12_000)},
    },
    {
        "name": "late payment after the account expired",
        "expected_variance": "exact",
        "options": {
            "expected_amount": naira(5_000),
            "amount_paid": naira(5_000),
            "expires_at": datetime(2026, 10, 30, 10, 0, 0, tzinfo=timezone.utc),
            "paid_at": datetime(2026, 10, 30, 10, 20, 0, tzinfo=timezone.utc),
        },
    },
    {
        "name": "late and underpaid at once",
        "expected_variance": "underpayment",
        "options": {
            "expected_amount": naira(5_000),
            "amount_paid": naira(4_000),
            "expires_at": datetime(2026, 10, 30, 10, 0, 0, tzinfo=timezone.utc),
            "paid_at": datetime(2026, 10, 30, 10, 30, 0, tzinfo=timezone.utc),
        },
    },
)


__all__ = [
    "INFLOW_SCENARIOS",
    "MOCK_DEFAULT_SECRET",
    "MOCK_PROVIDER_NAME",
    "MOCK_SCHEME",
    "MockProvider",
    "MockWebhook",
    "mock",
    "mock_capabilities",
]
