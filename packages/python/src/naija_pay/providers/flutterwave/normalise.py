"""Turning Flutterwave's payloads into naija-pay's.

Kept separate from the client so it can be tested against recorded fixtures with no HTTP
at all, and so the mapping decisions are reviewable in one place.

Every normalised object keeps ``raw``, so nothing Flutterwave returns is ever lost.

The one thing to understand before reading further: **Flutterwave puts decimals on the
wire.** Paystack sends ``500000`` and means 5,000 naira; Flutterwave sends ``5000`` and
means the same thing, and sends ``20000.5`` for twenty thousand naira and fifty kobo.
Every amount therefore passes through ``_as_money`` below, which converts through
``from_major`` so the conversion is checked rather than multiplied by 100 and hoped for.

Mirrors ``packages/ts/src/providers/flutterwave/normalise.ts``.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal

from naija_pay.core.banks import match_institution, merger_warning_for
from naija_pay.core.money import Money, MoneyError, from_major
from naija_pay.providers.flutterwave.capabilities import (
    CHANNEL_FROM_FLUTTERWAVE,
    FLUTTERWAVE_PROVIDER_NAME,
)

TransactionStatus = Literal["pending", "successful", "failed", "abandoned", "reversed"]

#: Flutterwave's transaction statuses, mapped onto ours.
#:
#: An unrecognised status becomes ``pending`` rather than being guessed at as successful
#: -- the safe direction, since ``pending`` means "do not give value yet".
_STATUS_MAP: dict[str, str] = {
    "successful": "successful",
    "success": "successful",
    "failed": "failed",
    "cancelled": "abandoned",
    "abandoned": "abandoned",
    "reversed": "reversed",
    "pending": "pending",
    "pending-validation": "pending",
}

#: Flutterwave's transfer statuses, which are upper-case and include a trap.
#:
#: ``NEW`` is the status every freshly created transfer has, and it means **queued**, not
#: done. The enclosing envelope says ``"status": "success"`` and ``"message": "Transfer
#: Queued Successfully"`` at the same time, so reading the envelope instead of
#: ``data.status`` makes every payout look complete the instant it is accepted. That is
#: the most dangerous misreading of this API, so ``NEW`` maps to ``pending`` and the
#: adapter's own tests assert it.
_TRANSFER_STATUS_MAP: dict[str, str] = {
    "new": "pending",
    "pending": "pending",
    "successful": "successful",
    "success": "successful",
    "failed": "failed",
    "cancelled": "abandoned",
    "reversed": "reversed",
}

_REFUND_STATUS_MAP: dict[str, str] = {
    "completed": "processed",
    "successful": "processed",
    "processed": "processed",
    "pending": "pending",
    "processing": "processing",
    "failed": "failed",
}


def normalise_status(flutterwave_status: Any) -> str:
    if not isinstance(flutterwave_status, str):
        return "pending"
    return _STATUS_MAP.get(flutterwave_status.lower(), "pending")


def normalise_transfer_status(flutterwave_status: Any) -> str:
    if not isinstance(flutterwave_status, str):
        return "pending"
    return _TRANSFER_STATUS_MAP.get(flutterwave_status.lower(), "pending")


def normalise_channel(flutterwave_channel: Any) -> str | None:
    if not isinstance(flutterwave_channel, str):
        return None
    return CHANNEL_FROM_FLUTTERWAVE.get(flutterwave_channel.lower())


def _as_record(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _as_string(value: Any) -> str | None:
    return value if isinstance(value, str) and value != "" else None


def _as_present_string(value: Any) -> str | None:
    """A string that is really there.

    Flutterwave uses the literal ``"N/A"`` where a field does not apply, notably in
    virtual-account responses (``"amount": "N/A"``, ``"expiry_date": "N/A"``). Treating
    that as a value produces an unparseable date or a NaN amount, so it is filtered here.
    """
    text = _as_string(value)
    return None if text is None or text == "N/A" else text


def _as_datetime(value: Any) -> datetime | None:
    text = _as_present_string(value)
    if text is None:
        return None
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None


def _as_money(value: Any, currency: Any) -> Money | None:
    """A Flutterwave amount -- a decimal in major units -- as integer minor units.

    Flutterwave sends ``amount`` as a JSON number (``5000``, ``20000.5``) and sometimes
    as a string. Both are accepted, and both go through ``from_major``, which rounds the
    scaled integer and then asserts the round trip, so ``3.29`` becomes exactly 329
    rather than the 328.99999999999994 a plain multiply produces.

    Returns None rather than raising on a value that is absent, negative, or carries more
    precision than the currency has. A normaliser is reading somebody else's payload and
    must not take the process down; the adapter surfaces ``raw`` alongside, so nothing is
    hidden.
    """
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        major: float = value
    else:
        text = _as_present_string(value)
        if text is None:
            return None
        try:
            major = float(text)
        except ValueError:
            return None

    if major != major or major in (float("inf"), float("-inf")) or major < 0:
        return None

    code = _as_string(currency) or "NGN"
    try:
        return from_major(major, code)
    except MoneyError:
        return None


def _as_flag(value: Any) -> bool:
    """Flutterwave returns ``requires_approval`` and ``is_approved`` as 0/1 integers."""
    if isinstance(value, bool):
        return value
    return isinstance(value, (int, float)) and value != 0


@dataclass(frozen=True, slots=True)
class Customer:
    email: str | None
    name: str | None
    phone: str | None
    provider_customer_code: str | None


def _to_customer(value: Any) -> Customer | None:
    bag = _as_record(value)
    email = _as_string(bag.get("email"))
    name = _as_string(bag.get("name")) or _as_string(bag.get("fullname"))
    phone = _as_string(bag.get("phone_number")) or _as_string(bag.get("phonenumber"))
    raw_id = bag.get("id")
    code = None if raw_id is None else str(raw_id)
    if not email and not name and not phone and not code:
        return None
    return Customer(email=email, name=name, phone=phone, provider_customer_code=code)


@dataclass(frozen=True, slots=True)
class CardAuthorization:
    #: Flutterwave's reusable card token. Only present on a verify response when the
    #: card was tokenised -- unlike Paystack's authorization code, which is always there.
    code: str
    last4: str | None
    brand: str | None
    bank: str | None
    reusable: bool
    #: Flutterwave's device fingerprint. Not a card fingerprint; see the note below.
    signature: str | None


def _to_authorization(value: Any, device_fingerprint: Any) -> CardAuthorization | None:
    bag = _as_record(value)
    token = _as_string(bag.get("token"))
    if not token:
        return None
    return CardAuthorization(
        code=token,
        last4=_as_string(bag.get("last_4digits")),
        brand=_as_string(bag.get("type")),
        bank=_as_string(bag.get("issuer")),
        reusable=True,
        # Paystack's `signature` identifies the card. Flutterwave has no equivalent, and
        # `device_fingerprint` identifies the browser the payment came from, not the
        # card. It is carried here because it is the nearest field, and named honestly in
        # the comment rather than passed off as a card fingerprint.
        signature=_as_string(device_fingerprint),
    )


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
    #: Flutterwave's own code, authoritative for calling Flutterwave. Never substituted.
    bank_code: str | None
    #: Flutterwave's numeric bank id from GET /banks, kept for round-tripping.
    bank_id: str | None
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
    bank_id: str | None = None,
) -> BankAccount:
    """Attach naija-data enrichment to a bank account, without changing its code."""
    found = match_institution(code=bank_code, name=bank_name)
    warning = merger_warning_for(found.institution) if found else None

    return BankAccount(
        account_number=account_number,
        account_name=account_name,
        bank_name=bank_name,
        bank_code=bank_code,
        bank_id=bank_id,
        provider=FLUTTERWAVE_PROVIDER_NAME,
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
    #: What the customer was asked for.
    amount: Money | None
    #: What was actually taken from the customer. Flutterwave's ``charged_amount``
    #: exceeds ``amount`` whenever the customer bears the transaction fee, and this is
    #: the field to reconcile a bank statement against.
    amount_paid: Money | None
    fees: Money | None
    #: What reaches your Flutterwave balance after fees -- Flutterwave's
    #: ``amount_settled``. Paystack has no equivalent on a verify response.
    amount_settled: Money | None
    channel: str | None
    paid_at: datetime | None
    created_at: datetime | None
    customer: Customer | None
    authorization: CardAuthorization | None
    #: Flutterwave's numeric transaction id, needed to verify or refund.
    transaction_id: str | None
    provider: str
    raw: Any


def to_transaction(data: Any) -> Transaction:
    bag = _as_record(data)
    currency = bag.get("currency")
    raw_id = bag.get("id")
    status = normalise_status(bag.get("status"))

    return Transaction(
        reference=_as_string(bag.get("tx_ref")) or "",
        provider_reference=_as_string(bag.get("flw_ref")) or "",
        status=status,
        amount=_as_money(bag.get("amount"), currency),
        amount_paid=_as_money(bag.get("charged_amount"), currency),
        fees=_as_money(bag.get("app_fee"), currency),
        amount_settled=_as_money(bag.get("amount_settled"), currency),
        channel=normalise_channel(bag.get("payment_type")),
        # Flutterwave has no separate paid_at: created_at on a successful transaction is
        # when it was created, which is the closest honest answer, so this is only set
        # once the transaction actually succeeded.
        paid_at=_as_datetime(bag.get("created_at")) if status == "successful" else None,
        created_at=_as_datetime(bag.get("created_at")),
        customer=_to_customer(bag.get("customer")),
        authorization=_to_authorization(bag.get("card"), bag.get("device_fingerprint")),
        transaction_id=None if raw_id is None else str(raw_id),
        provider=FLUTTERWAVE_PROVIDER_NAME,
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
    #: Flutterwave's order_ref, which identifies the account for later lookups.
    order_reference: str | None
    expires_at: datetime | None
    provider: str
    raw: Any


def to_virtual_account(
    data: Any, *, reference: str | None = None, kind: str | None = None
) -> VirtualAccount:
    """Normalise a virtual account.

    Flutterwave answers with ``response_code`` ``"02"`` and ``response_message``
    ``"Transaction in progress"`` -- an acknowledgement, not a finished account. The
    account number is usable, but KYC may still be running, so ``kyc_status`` is
    ``pending`` unless Flutterwave says otherwise. ``"00"`` is its success code.
    """
    bag = _as_record(data)
    account_number = _as_present_string(bag.get("account_number")) or ""
    response_code = _as_string(bag.get("response_code"))

    accounts: tuple[BankAccount, ...] = ()
    if account_number:
        accounts = (
            enrich(
                account_number=account_number,
                # A virtual account has no holder name of its own; `note` carries the
                # narration the payer sees. Left empty rather than inventing one.
                account_name=_as_present_string(bag.get("narration")) or "",
                bank_name=_as_present_string(bag.get("bank_name")),
                bank_code=_as_present_string(bag.get("bank_code")),
            ),
        )

    # An expiring account is dynamic. Flutterwave does not echo is_permanent, so the
    # caller's own intent is used when given, and the expiry date is the fallback signal.
    expires_at = _as_datetime(bag.get("expiry_date"))
    resolved_kind = kind or ("static" if expires_at is None else "dynamic")
    status_text = _as_present_string(bag.get("status"))

    return VirtualAccount(
        reference=reference or _as_string(bag.get("tx_ref")) or "",
        accounts=accounts,
        kind=resolved_kind,
        status="inactive" if (status_text or "").lower() == "inactive" else "active",
        customer=_to_customer(bag),
        kyc_status="verified" if response_code == "00" else "pending",
        order_reference=_as_string(bag.get("order_ref")),
        expires_at=expires_at,
        provider=FLUTTERWAVE_PROVIDER_NAME,
        raw=data,
    )


@dataclass(frozen=True, slots=True)
class Payout:
    reference: str
    provider_reference: str
    status: str
    amount: Money | None
    fee: Money | None
    recipient: BankAccount | None
    failure_reason: str | None
    #: Flutterwave's numeric transfer id.
    recipient_id: str | None
    #: Flutterwave has no OTP step on transfers; Paystack does. The field is present so
    #: both adapters return the same shape, and it is always False here.
    awaiting_otp: bool
    #: True when Flutterwave's ``requires_approval`` is set and ``is_approved`` is not:
    #: the transfer will not move until a human approves it on the dashboard. The
    #: Flutterwave equivalent of Paystack's OTP gate, and reported for the same reason --
    #: so nobody mistakes an accepted transfer for a sent one.
    awaiting_approval: bool
    provider: str
    raw: Any


def to_payout(data: Any) -> Payout:
    bag = _as_record(data)
    currency = _as_string(bag.get("currency"))
    account_number = _as_string(bag.get("account_number"))
    raw_id = bag.get("id")
    requires_approval = _as_flag(bag.get("requires_approval"))
    is_approved = _as_flag(bag.get("is_approved"))

    recipient = None
    if account_number:
        recipient = enrich(
            account_number=account_number,
            account_name=_as_string(bag.get("full_name")) or "",
            bank_name=_as_string(bag.get("bank_name")),
            bank_code=_as_string(bag.get("bank_code")),
        )

    return Payout(
        reference=_as_string(bag.get("reference")) or "",
        provider_reference="" if raw_id is None else str(raw_id),
        status=normalise_transfer_status(bag.get("status")),
        amount=_as_money(bag.get("amount"), currency),
        fee=_as_money(bag.get("fee"), currency),
        recipient=recipient,
        failure_reason=_as_string(bag.get("complete_message")),
        recipient_id=None if raw_id is None else str(raw_id),
        awaiting_otp=False,
        awaiting_approval=requires_approval and not is_approved,
        provider=FLUTTERWAVE_PROVIDER_NAME,
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
    bag = _as_record(data)
    status = _as_string(bag.get("status"))
    raw_id = bag.get("id")
    tx_id = bag.get("tx_id")

    return Refund(
        provider_reference="" if raw_id is None else str(raw_id),
        transaction_reference=(str(tx_id) if tx_id is not None else _as_string(bag.get("flw_ref"))),
        status=_REFUND_STATUS_MAP.get((status or "").lower(), "pending"),
        # A refund response carries no currency; NGN is Flutterwave's default and the
        # adapter passes the transaction's currency in when it knows it.
        amount=_as_money(bag.get("amount_refunded"), bag.get("currency")),
        provider=FLUTTERWAVE_PROVIDER_NAME,
        raw=data,
    )


@dataclass(frozen=True, slots=True)
class SplitAccount:
    #: Flutterwave's ``subaccount_id`` (``RS_...``), the value to put on a checkout.
    code: str
    business_name: str | None
    settlement_account: BankAccount | None
    #: The subaccount's default share, in basis points, converted from Flutterwave's
    #: decimal fraction. ``0.09`` on the wire becomes 900 here. None for a flat split,
    #: where ``flat_charge`` carries the amount instead.
    percentage_charge: int | None
    #: The subaccount's default flat share, in minor units. None for a percentage split.
    flat_charge: Money | None
    verified: bool
    provider: str
    raw: Any


def to_split_account(data: Any) -> SplitAccount:
    bag = _as_record(data)
    split_type = (_as_string(bag.get("split_type")) or "").lower()
    raw_value = bag.get("split_value")
    split_value = (
        float(raw_value)
        if isinstance(raw_value, (int, float)) and not isinstance(raw_value, bool)
        else None
    )
    is_flat = split_type == "flat"

    settlement_account = None
    if _as_string(bag.get("account_number")):
        settlement_account = enrich(
            account_number=_as_string(bag.get("account_number")) or "",
            account_name=_as_string(bag.get("full_name")) or "",
            bank_name=_as_string(bag.get("bank_name")),
            bank_code=_as_string(bag.get("account_bank")),
        )

    # Rounded, because the fraction is Flutterwave's and need not land on a whole basis
    # point. Guarded against a nonsensical value above 100%.
    percentage_charge = None
    if not is_flat and split_value is not None and 0 <= split_value <= 1:
        percentage_charge = round(split_value * 10_000)

    return SplitAccount(
        code=_as_string(bag.get("subaccount_id")) or "",
        business_name=_as_string(bag.get("full_name")) or _as_string(bag.get("business_name")),
        settlement_account=settlement_account,
        percentage_charge=percentage_charge,
        flat_charge=_as_money(split_value, "NGN") if is_flat else None,
        # Flutterwave verifies settlement bank details asynchronously and does not report
        # the outcome on this object, so this is never asserted as True from the payload.
        verified=False,
        provider=FLUTTERWAVE_PROVIDER_NAME,
        raw=data,
    )


@dataclass(frozen=True, slots=True)
class WalletAccount:
    #: Use this as ``debit_subaccount`` on a transfer, and to read the balance.
    reference: str
    #: Use this as ``account_number`` for a wallet-to-wallet transfer.
    barter_id: str | None
    account_name: str | None
    email: str | None
    status: str
    #: The wallet's own NUBAN, which funds it when money is transferred in.
    account: BankAccount | None
    provider: str
    raw: Any


def to_wallet_account(data: Any) -> WalletAccount:
    bag = _as_record(data)
    nuban = _as_string(bag.get("nuban"))

    account = None
    if nuban:
        account = enrich(
            account_number=nuban,
            account_name=_as_string(bag.get("account_name")) or "",
            bank_name=_as_string(bag.get("bank_name")),
            bank_code=_as_string(bag.get("bank_code")),
        )

    return WalletAccount(
        reference=_as_string(bag.get("account_reference")) or "",
        barter_id=_as_string(bag.get("barter_id")),
        account_name=_as_string(bag.get("account_name")),
        email=_as_string(bag.get("email")),
        status=(
            "active" if (_as_string(bag.get("status")) or "").upper() == "ACTIVE" else "inactive"
        ),
        account=account,
        provider=FLUTTERWAVE_PROVIDER_NAME,
        raw=data,
    )


@dataclass(frozen=True, slots=True)
class WalletBalance:
    reference: str
    available: Money | None
    ledger: Money | None
    provider: str
    raw: Any


def to_wallet_balance(data: Any, reference: str) -> WalletBalance:
    bag = _as_record(data)
    currency = _as_string(bag.get("currency")) or "NGN"

    return WalletBalance(
        reference=_as_string(bag.get("account_reference")) or reference,
        available=_as_money(bag.get("available_balance"), currency),
        ledger=_as_money(bag.get("ledger_balance"), currency),
        provider=FLUTTERWAVE_PROVIDER_NAME,
        raw=data,
    )


__all__ = [
    "BankAccount",
    "CardAuthorization",
    "Customer",
    "Institution",
    "Payout",
    "Refund",
    "SplitAccount",
    "Transaction",
    "TransactionStatus",
    "VirtualAccount",
    "WalletAccount",
    "WalletBalance",
    "enrich",
    "normalise_channel",
    "normalise_status",
    "normalise_transfer_status",
    "to_payout",
    "to_refund",
    "to_split_account",
    "to_transaction",
    "to_virtual_account",
    "to_wallet_account",
    "to_wallet_balance",
]
