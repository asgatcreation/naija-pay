"""Normalised events, and the inflow rules.

Every provider's webhook becomes one of these shapes, keeps its raw payload, and carries
the honest ``signature_strength`` it earned.

The inflow rules are the part worth reading. Pay-by-transfer is where real money goes
wrong: a customer sends 4,900 naira for a 5,000 naira invoice, or 50,000 by mistake, or
pays twenty minutes after the dynamic account expired, or the provider delivers the same
notification three times. Every provider leaves these to you -- only Korapay documents
guidance at all. So each case is a **named, configurable rule** here rather than
something each developer rediscovers in production.

Mirrors ``packages/ts/src/core/events.ts``.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal

from naija_pay.core.money import Money, compare, money, subtract
from naija_pay.core.signatures import SignatureStrength

#: The normalised event vocabulary.
#:
#: ``unknown`` is deliberate: an event type we have not mapped is still delivered,
#: verified, with its raw payload, rather than being dropped. A provider adding an event
#: must never break a running application.
EventType = Literal[
    "payment.successful",
    "payment.failed",
    "payment.pending",
    "payment.reversed",
    "virtual_account.credited",
    "virtual_account.assigned",
    "virtual_account.assignment_failed",
    "transfer.successful",
    "transfer.failed",
    "transfer.reversed",
    "refund.processed",
    "refund.failed",
    "subscription.created",
    "subscription.disabled",
    "subscription.charge_failed",
    "mandate.approved",
    "mandate.cancelled",
    "mandate.debited",
    "subaccount.settled",
    "customer.identification_succeeded",
    "customer.identification_failed",
    "unknown",
]

#: How an inflow's amount compares with what was expected.
InflowVariance = Literal["exact", "overpayment", "underpayment", "unexpected"]

OverpaymentAction = Literal["credit_full", "credit_expected", "reject", "manual_review"]
UnderpaymentAction = Literal["credit_partial", "reject", "manual_review"]
LatePaymentAction = Literal["accept", "reject", "manual_review"]


@dataclass(frozen=True, slots=True)
class EventSender:
    #: As the provider reported it. Masked in logs by the redactor.
    name: str | None = None
    bank: str | None = None
    account_number: str | None = None


@dataclass(frozen=True, slots=True)
class VirtualAccountInflow:
    reference: str
    account_number: str
    amount_paid: Money
    variance: InflowVariance
    is_late: bool
    #: What the dynamic account asked for. None for a static account with no amount.
    expected_amount: Money | None = None
    fees: Money | None = None
    settled_amount: Money | None = None
    sender: EventSender | None = None
    #: NIBSS session id, where the provider supplies one.
    session_id: str | None = None
    paid_at: datetime | None = None
    #: When the account expired, for a dynamic account.
    expires_at: datetime | None = None
    #: Unsigned difference; ``variance`` says which direction it is in.
    variance_amount: Money | None = None


@dataclass(frozen=True, slots=True)
class NaijaPayEvent:
    #: Stable per provider event, and the key the idempotency store uses.
    id: str
    type: EventType
    occurred_at: datetime
    provider: str
    signature_strength: SignatureStrength
    data: Any
    #: The provider's untouched payload. Always available.
    raw: Any
    #: The provider's own event name, kept so ``unknown`` is still actionable.
    provider_event: str | None = None


@dataclass(frozen=True, slots=True)
class InflowRules:
    overpayment: OverpaymentAction = "credit_full"
    underpayment: UnderpaymentAction = "manual_review"
    late_payment: LatePaymentAction = "accept"


#: Defaults chosen to be conservative with other people's money.
#:
#: An overpayment is credited in full because the money genuinely arrived and refusing it
#: strands a customer's funds. An underpayment goes to review rather than being credited
#: partially, because partial credit silently changes what the customer bought. A late
#: payment is accepted, because the money has arrived and the expiry was our constraint,
#: not theirs.
DEFAULT_INFLOW_RULES = InflowRules()


@dataclass(frozen=True, slots=True)
class InflowClassification:
    variance: InflowVariance
    variance_amount: Money | None
    is_late: bool


@dataclass(frozen=True, slots=True)
class InflowDecision:
    action: Literal["credit", "reject", "manual_review", "ignore"]
    reason: str
    amount: Money | None = None


def classify_inflow(
    *,
    expected_amount: Money | None,
    amount_paid: Money,
    paid_at: datetime | None = None,
    expires_at: datetime | None = None,
) -> InflowClassification:
    """Classify an inflow against what was expected."""
    is_late = bool(paid_at and expires_at and paid_at > expires_at)

    if expected_amount is None:
        # A static account has no expected amount, so no variance exists to report. This
        # is the normal case for wallet funding, not an anomaly.
        return InflowClassification(variance="unexpected", variance_amount=None, is_late=is_late)

    direction = compare(amount_paid, expected_amount)
    if direction == 0:
        return InflowClassification(
            variance="exact",
            variance_amount=money(0, amount_paid.currency),
            is_late=is_late,
        )
    if direction > 0:
        return InflowClassification(
            variance="overpayment",
            variance_amount=subtract(amount_paid, expected_amount),
            is_late=is_late,
        )
    return InflowClassification(
        variance="underpayment",
        # Kept positive; `variance` says which direction it is in.
        variance_amount=subtract(expected_amount, amount_paid),
        is_late=is_late,
    )


def decide_inflow(
    *,
    variance: InflowVariance,
    amount_paid: Money,
    expected_amount: Money | None = None,
    is_late: bool = False,
    rules: InflowRules | None = None,
    already_processed: bool = False,
) -> InflowDecision:
    """Decide what to do with an inflow, given the rules.

    ``already_processed`` short-circuits everything: a duplicate delivery is always
    ignored, and that is not configurable. Every Tier 1 provider retries webhooks --
    Paystack for 72 hours -- so duplicates are certain, and "give value twice" must never
    be reachable through configuration.
    """
    active = rules or DEFAULT_INFLOW_RULES

    # A guard, not an assumption. An async store's coroutine is always truthy, which
    # would make every inflow look like a duplicate and silently credit nobody.
    if not isinstance(already_processed, bool):
        raise TypeError(
            "decide_inflow: already_processed must be a bool. It looks like an "
            "un-awaited coroutine was passed -- a coroutine is always truthy, so every "
            "inflow would be treated as a duplicate and nobody would be credited."
        )

    if already_processed:
        return InflowDecision(
            action="ignore",
            reason="this event has already been processed; giving value twice is never correct",
        )

    if is_late:
        if active.late_payment == "reject":
            return InflowDecision(
                action="reject", reason="the payment arrived after the account expired"
            )
        if active.late_payment == "manual_review":
            return InflowDecision(
                action="manual_review", reason="the payment arrived after the account expired"
            )
        # "accept" falls through to the amount rules below: being late does not change
        # whether the right amount arrived.

    if variance == "exact":
        return InflowDecision(
            action="credit", amount=amount_paid, reason="the expected amount arrived"
        )

    if variance == "unexpected":
        # No expected amount, so there is nothing to compare against: credit what came in.
        return InflowDecision(
            action="credit",
            amount=amount_paid,
            reason="a static account received funds, with no expected amount to compare",
        )

    if variance == "overpayment":
        if active.overpayment == "credit_full":
            return InflowDecision(
                action="credit",
                amount=amount_paid,
                reason="overpaid; crediting the full amount received",
            )
        if active.overpayment == "credit_expected":
            return InflowDecision(
                action="credit",
                amount=expected_amount or amount_paid,
                reason="overpaid; crediting the expected amount, the excess needs refunding",
            )
        if active.overpayment == "reject":
            return InflowDecision(
                action="reject", reason="overpaid, and the rules reject overpayments"
            )
        return InflowDecision(action="manual_review", reason="overpaid")

    # underpayment
    if active.underpayment == "credit_partial":
        return InflowDecision(
            action="credit", amount=amount_paid, reason="underpaid; crediting only what arrived"
        )
    if active.underpayment == "reject":
        return InflowDecision(
            action="reject", reason="underpaid, and the rules reject underpayments"
        )
    return InflowDecision(action="manual_review", reason="underpaid")


class IdempotencyStore:
    """Remembers which events have been processed, so one is never acted on twice.

    Deliberately tiny: an application supplies a Redis- or database-backed store in
    production by implementing ``has`` and ``mark``.
    """

    def has(self, event_id: str) -> bool:  # pragma: no cover - interface
        raise NotImplementedError

    def mark(self, event_id: str) -> None:  # pragma: no cover - interface
        raise NotImplementedError


@dataclass(slots=True)
class MemoryStore(IdempotencyStore):
    """In-memory store.

    Not for production: it forgets on restart and is not shared between processes, so two
    instances would each give value once.
    """

    _seen: set[str] = field(default_factory=set)

    def has(self, event_id: str) -> bool:
        return event_id in self._seen

    def mark(self, event_id: str) -> None:
        self._seen.add(event_id)

    def size(self) -> int:
        return len(self._seen)


__all__: Sequence[str] = [
    "DEFAULT_INFLOW_RULES",
    "EventSender",
    "EventType",
    "IdempotencyStore",
    "InflowClassification",
    "InflowDecision",
    "InflowRules",
    "InflowVariance",
    "LatePaymentAction",
    "MemoryStore",
    "NaijaPayEvent",
    "OverpaymentAction",
    "UnderpaymentAction",
    "VirtualAccountInflow",
    "classify_inflow",
    "decide_inflow",
]
