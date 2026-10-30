"""Turning Paystack's payloads into naija-pay's.

Kept separate from the client so it can be tested against recorded fixtures with no HTTP
at all, and so the mapping decisions are reviewable in one place.

Every normalised object keeps ``raw``, so nothing Paystack returns is ever lost.

Mirrors ``packages/ts/src/providers/paystack/normalise.ts``.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal

from naija_pay.core.banks import match_institution, merger_warning_for
from naija_pay.core.money import Money, money
from naija_pay.providers.paystack.capabilities import (
    CHANNEL_FROM_PAYSTACK,
    PAYSTACK_PROVIDER_NAME,
)

TransactionStatus = Literal["pending", "successful", "failed", "abandoned", "reversed"]

#: Paystack's transaction statuses, mapped onto ours.
#:
#: ``ongoing``, ``processing`` and ``queued`` are all "not finished yet" from an
#: application's point of view, so they collapse to ``pending``. An unrecognised status
#: also becomes ``pending`` rather than being guessed at as successful -- the safe
#: direction, since ``pending`` means "do not give value yet".
_STATUS_MAP: dict[str, str] = {
    "success": "successful",
    "failed": "failed",
    "abandoned": "abandoned",
    "reversed": "reversed",
    "pending": "pending",
    "ongoing": "pending",
    "processing": "pending",
    "queued": "pending",
}

#: Paystack's transfer statuses.
#:
#: ``otp`` is the one that matters: it means the transfer is waiting for a human to enter
#: a code sent to the business phone, so it is emphatically not successful.
_TRANSFER_STATUS_MAP: dict[str, str] = {
    "success": "successful",
    "failed": "failed",
    "reversed": "reversed",
    "pending": "pending",
    "otp": "pending",
    "abandoned": "abandoned",
}

_REFUND_STATUS_MAP: dict[str, str] = {
    "pending": "pending",
    "processing": "processing",
    "processed": "processed",
    "failed": "failed",
    # Paystack's "needs-attention" refunds require bank details before they can proceed.
    "needs-attention": "failed",
}


def normalise_status(value: Any) -> str:
    if not isinstance(value, str):
        return "pending"
    return _STATUS_MAP.get(value.lower(), "pending")


def normalise_transfer_status(value: Any) -> str:
    if not isinstance(value, str):
        return "pending"
    return _TRANSFER_STATUS_MAP.get(value.lower(), "pending")


def normalise_channel(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    return CHANNEL_FROM_PAYSTACK.get(value)


def _record(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _text(value: Any) -> str | None:
    return value if isinstance(value, str) and value != "" else None


def _date(value: Any) -> datetime | None:
    if not isinstance(value, str) or value == "":
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _money(value: Any, currency: Any) -> Money | None:
    """Paystack returns amounts as integers in the currency subunit, which is what we want.

    It is still validated through ``money()`` rather than trusted, because a float
    arriving here would be a silent corruption.
    """
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return None
    code = currency if isinstance(currency, str) and currency != "" else "NGN"
    return money(value, code)


@dataclass(frozen=True, slots=True)
class CardAuthorization:
    code: str
    last4: str | None
    brand: str | None
    bank: str | None
    reusable: bool
    #: Paystack's card fingerprint, for recognising the same card again.
    signature: str | None


@dataclass(frozen=True, slots=True)
class Customer:
    email: str | None
    name: str | None
    phone: str | None
    provider_customer_code: str | None


@dataclass(frozen=True, slots=True)
class Institution:
    id: str
    name: str
    type: str
    nip_code: str | None
    cbn_code: str | None
    status: str
    merged_into: str | None
    unverified_codes: tuple[str, ...]
    matched_by: str


@dataclass(frozen=True, slots=True)
class BankAccount:
    account_number: str
    account_name: str
    bank_name: str | None
    #: Paystack's own code, authoritative for calling Paystack. Never substituted.
    bank_code: str | None
    #: Paystack's bank slug, e.g. "titan-paystack", kept for round-tripping.
    bank_slug: str | None
    provider: str
    #: Enrichment from naija-data; None when no institution could be matched.
    institution: Institution | None
    #: Present when the matched institution has been merged into another.
    merger_warning: str | None


def enrich(
    *,
    account_number: str,
    account_name: str,
    bank_name: str | None = None,
    bank_code: str | None = None,
    bank_slug: str | None = None,
) -> BankAccount:
    """Attach naija-data enrichment to a bank account, without changing its code."""
    found = match_institution(code=bank_code, name=bank_name)
    warning = merger_warning_for(found.institution) if found else None

    return BankAccount(
        account_number=account_number,
        account_name=account_name,
        bank_name=bank_name,
        bank_code=bank_code,
        bank_slug=bank_slug,
        provider=PAYSTACK_PROVIDER_NAME,
        institution=(
            Institution(
                id=found.institution.id,
                name=found.institution.name,
                type=found.institution.type,
                nip_code=found.institution.nip_code,
                cbn_code=found.institution.cbn_code,
                status=found.institution.status,
                merged_into=found.institution.merged_into,
                unverified_codes=found.institution.unverified,
                matched_by=found.matched_by,
            )
            if found
            else None
        ),
        merger_warning=warning.message if warning else None,
    )


@dataclass(frozen=True, slots=True)
class Transaction:
    reference: str
    provider_reference: str
    status: str
    amount: Money | None
    amount_paid: Money | None
    fees: Money | None
    channel: str | None
    paid_at: datetime | None
    created_at: datetime | None
    customer: Customer | None
    authorization: CardAuthorization | None
    provider: str
    raw: Any


def to_transaction(data: Any) -> Transaction:
    bag = _record(data)
    currency = bag.get("currency")
    customer = _record(bag.get("customer"))
    auth = _record(bag.get("authorization"))

    first = _text(customer.get("first_name"))
    last = _text(customer.get("last_name"))
    name = " ".join(part for part in (first, last) if part) or None

    auth_code = _text(auth.get("authorization_code"))

    return Transaction(
        reference=_text(bag.get("reference")) or "",
        provider_reference=str(bag.get("id") or _text(bag.get("reference")) or ""),
        status=normalise_status(bag.get("status")),
        # `requested_amount` is what was asked for; `amount` is what was actually paid.
        # Paystack returns both, and conflating them hides partial and over payments.
        amount=_money(bag.get("requested_amount"), currency)
        or _money(bag.get("amount"), currency),
        amount_paid=_money(bag.get("amount"), currency),
        fees=_money(bag.get("fees"), currency),
        channel=normalise_channel(bag.get("channel")),
        paid_at=_date(bag.get("paid_at") or bag.get("paidAt")),
        created_at=_date(bag.get("created_at") or bag.get("createdAt")),
        customer=Customer(
            email=_text(customer.get("email")),
            name=name,
            phone=_text(customer.get("phone")),
            provider_customer_code=_text(customer.get("customer_code")),
        ),
        authorization=(
            CardAuthorization(
                code=auth_code,
                last4=_text(auth.get("last4")),
                brand=_text(auth.get("brand")),
                bank=_text(auth.get("bank")),
                reusable=auth.get("reusable") is True,
                signature=_text(auth.get("signature")),
            )
            if auth_code
            else None
        ),
        provider=PAYSTACK_PROVIDER_NAME,
        raw=data,
    )


@dataclass(frozen=True, slots=True)
class VirtualAccount:
    reference: str
    accounts: tuple[BankAccount, ...]
    kind: str
    status: str
    customer: Customer | None
    kyc_status: str
    provider: str
    raw: Any


def to_virtual_account(data: Any) -> VirtualAccount:
    bag = _record(data)
    bank = _record(bag.get("bank"))
    customer = _record(bag.get("customer"))
    assignment = _record(bag.get("assignment"))

    first = _text(customer.get("first_name"))
    last = _text(customer.get("last_name"))

    return VirtualAccount(
        reference=str(bag.get("id") or ""),
        accounts=(
            enrich(
                account_number=_text(bag.get("account_number")) or "",
                account_name=_text(bag.get("account_name")) or "",
                bank_name=_text(bank.get("name")),
                bank_slug=_text(bank.get("slug")),
            ),
        ),
        kind="static",
        status="inactive" if bag.get("active") is False else "active",
        customer=Customer(
            email=_text(customer.get("email")),
            name=" ".join(part for part in (first, last) if part) or None,
            phone=_text(customer.get("phone")),
            provider_customer_code=_text(customer.get("customer_code")),
        ),
        # Paystack reports identification asynchronously via customeridentification.*
        # events, so a freshly created account is pending rather than verified. Claiming
        # otherwise would let an application give value on an unverified identity.
        kyc_status="failed" if assignment.get("expired") is True else "pending",
        provider=PAYSTACK_PROVIDER_NAME,
        raw=data,
    )


@dataclass(frozen=True, slots=True)
class Payout:
    reference: str
    provider_reference: str
    status: str
    amount: Money | None
    #: Paystack's NUMERIC recipient id from the transfer response -- not the ``RCP_``
    #: code, which only appears when the recipient is created. Stringified so the two
    #: languages agree, since JSON numbers and strings normalise differently otherwise.
    recipient_id: str | None
    #: True when Paystack is waiting for an OTP that a human must supply.
    awaiting_otp: bool
    provider: str
    raw: Any


def to_payout(data: Any) -> Payout:
    bag = _record(data)
    raw_status = _text(bag.get("status"))

    return Payout(
        reference=_text(bag.get("reference")) or "",
        provider_reference=_text(bag.get("transfer_code")) or str(bag.get("id") or ""),
        status=normalise_transfer_status(bag.get("status")),
        amount=_money(bag.get("amount"), bag.get("currency")),
        recipient_id=(
            str(bag.get("recipient"))
            if isinstance(bag.get("recipient"), (str, int))
            and not isinstance(bag.get("recipient"), bool)
            else None
        ),
        awaiting_otp=(raw_status or "").lower() == "otp",
        provider=PAYSTACK_PROVIDER_NAME,
        raw=data,
    )


@dataclass(frozen=True, slots=True)
class Refund:
    provider_reference: str
    transaction_reference: str | None
    status: str
    amount: Money | None
    provider: str
    raw: Any


def to_refund(data: Any) -> Refund:
    bag = _record(data)
    transaction = _record(bag.get("transaction"))
    status = (_text(bag.get("status")) or "pending").lower()

    return Refund(
        provider_reference=str(bag.get("id") or ""),
        transaction_reference=_text(transaction.get("reference")),
        status=_REFUND_STATUS_MAP.get(status, "pending"),
        amount=_money(bag.get("amount"), bag.get("currency")),
        provider=PAYSTACK_PROVIDER_NAME,
        raw=data,
    )


@dataclass(frozen=True, slots=True)
class SplitAccount:
    code: str
    business_name: str | None
    settlement_account: BankAccount | None
    percentage_charge: float | None
    verified: bool
    provider: str
    raw: Any


def to_split_account(data: Any) -> SplitAccount:
    bag = _record(data)
    account_number = _text(bag.get("account_number"))

    return SplitAccount(
        code=_text(bag.get("subaccount_code")) or "",
        business_name=_text(bag.get("business_name")),
        settlement_account=(
            enrich(
                account_number=account_number,
                account_name=_text(bag.get("account_name")) or "",
                bank_name=_text(bag.get("settlement_bank")),
            )
            if account_number
            else None
        ),
        percentage_charge=(
            bag.get("percentage_charge")
            if isinstance(bag.get("percentage_charge"), (int, float))
            and not isinstance(bag.get("percentage_charge"), bool)
            else None
        ),
        verified=bag.get("is_verified") is True,
        provider=PAYSTACK_PROVIDER_NAME,
        raw=data,
    )


@dataclass(frozen=True, slots=True)
class Split:
    code: str
    name: str | None
    type: str
    currency: str | None
    parties: tuple[dict[str, Any], ...]
    provider: str
    raw: Any


def to_split(data: Any) -> Split:
    bag = _record(data)
    subaccounts = bag.get("subaccounts") if isinstance(bag.get("subaccounts"), list) else []

    parties = []
    for entry in subaccounts:
        row = _record(entry)
        inner = _record(row.get("subaccount"))
        parties.append(
            {
                "account": _text(inner.get("subaccount_code"))
                or _text(row.get("subaccount"))
                or "",
                "share": row.get("share") if isinstance(row.get("share"), (int, float)) else 0,
            }
        )

    return Split(
        code=_text(bag.get("split_code")) or "",
        name=_text(bag.get("name")),
        type="flat" if _text(bag.get("type")) == "flat" else "percentage",
        currency=_text(bag.get("currency")),
        parties=tuple(parties),
        provider=PAYSTACK_PROVIDER_NAME,
        raw=data,
    )


__all__ = [
    "BankAccount",
    "CardAuthorization",
    "Customer",
    "Institution",
    "Payout",
    "Refund",
    "Split",
    "SplitAccount",
    "Transaction",
    "TransactionStatus",
    "VirtualAccount",
    "enrich",
    "normalise_channel",
    "normalise_status",
    "normalise_transfer_status",
    "to_payout",
    "to_refund",
    "to_split",
    "to_split_account",
    "to_transaction",
    "to_virtual_account",
]
