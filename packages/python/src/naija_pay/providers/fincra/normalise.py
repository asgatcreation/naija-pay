"""Turning Fincra's payloads into naija-pay's.

Kept separate from the client so it can be tested against recorded fixtures with no HTTP
at all, and so the mapping decisions are reviewable in one place. Every normalised object
keeps ``raw``, so nothing Fincra returns is ever lost.

Three things to understand before reading further.

1. **Decimals on the wire, sometimes with six places.** Fincra's amounts are major units
   -- ``350`` is three hundred and fifty naira -- and its balances and fees come back with
   up to six decimal places (``4145.558824``, ``fee: 9090.909091``). No currency has six
   decimal places, so ``as_money`` returns None for a value that cannot be represented
   exactly rather than rounding somebody's money. The exact figure stays in ``raw``.
2. **Statuses are documented, and there are three sets of them.** Fincra publishes a
   general table, a payout table and a checkout table. They overlap but are not identical,
   and ``expired`` is real: a charge pending for more than two hours becomes expired.
3. **The envelope has two names.** ``{"status": true}`` on checkout, ``{"success": true}``
   on payouts, banks and wallets. That is handled in the client rather than here.

Mirrors ``packages/ts/src/providers/fincra/normalise.ts``.
"""

from __future__ import annotations

import math
import re
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Generic, Literal, TypeVar

from naija_pay.core.banks import match_institution, merger_warning_for
from naija_pay.core.money import Money, MoneyError, from_major
from naija_pay.providers.fincra.capabilities import (
    CHANNEL_FROM_FINCRA,
    FINCRA_PROVIDER_NAME,
)

TransactionStatus = Literal["pending", "successful", "failed", "abandoned", "reversed"]

#: Fincra's collection and charge statuses, from its published table.
#:
#: ``initiated`` means the charge exists and nobody has paid yet, so it is ``pending``.
#: ``expired`` is Fincra's word for a charge the customer never completed, which is our
#: ``abandoned``. Anything unrecognised becomes ``pending``, the safe direction.
_STATUS_MAP: dict[str, str] = {
    "initiated": "pending",
    "pending": "pending",
    "processing": "pending",
    "success": "successful",
    "successful": "successful",
    "failed": "failed",
    "expired": "abandoned",
    "cancelled": "abandoned",
    "abandoned": "abandoned",
    "reversed": "reversed",
}

#: Fincra's payout statuses, from its own payout table: ``processing``, ``failed``,
#: ``successful``.
#:
#: ``processing`` is explicitly "in progress and awaiting user authorization", so it maps
#: to ``pending`` and never to successful. A payout API that answered ``success: true`` at
#: the HTTP level and ``processing`` in the body is exactly the trap Flutterwave's ``NEW``
#: status sets, and Fincra's documentation warns about it in the same words we would.
_PAYOUT_STATUS_MAP: dict[str, str] = {
    "pending": "pending",
    "processing": "pending",
    "success": "successful",
    "successful": "successful",
    "failed": "failed",
    "cancelled": "abandoned",
    "expired": "abandoned",
    "reversed": "reversed",
}

_REFUND_STATUS_MAP: dict[str, str] = {
    "pending": "pending",
    "initiated": "pending",
    "processing": "processing",
    "success": "processed",
    "successful": "processed",
    "processed": "processed",
    "completed": "processed",
    "failed": "failed",
}

_VA_STATUS_MAP: dict[str, str] = {
    "approved": "verified",
    "pending": "pending",
    "reviewed": "pending",
    "declined": "failed",
    "expired": "failed",
    "closed": "failed",
}


def normalise_status(fincra_status: Any) -> str:
    if not isinstance(fincra_status, str):
        return "pending"
    return _STATUS_MAP.get(fincra_status.strip().lower(), "pending")


def normalise_payout_status(fincra_status: Any) -> str:
    if not isinstance(fincra_status, str):
        return "pending"
    return _PAYOUT_STATUS_MAP.get(fincra_status.strip().lower(), "pending")


def normalise_channel(fincra_channel: Any) -> str | None:
    if not isinstance(fincra_channel, str):
        return None
    key = fincra_channel.strip()
    return CHANNEL_FROM_FINCRA.get(key) or CHANNEL_FROM_FINCRA.get(key.lower())


def _as_record(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _as_string(value: Any) -> str | None:
    if isinstance(value, str) and value.strip() != "":
        return value
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return str(value)
    return None


#: An ISO-ish stamp with **no timezone**, which Fincra sends on refunds.
#:
#: Most Fincra fields are proper ISO 8601 with a ``Z``, but a refund's ``initiatedAt`` and
#: ``completedAt`` are ``"2023-12-07 17:39:00"``: a space instead of a T, and no offset.
#: That shape is a cross-language hazard -- JavaScript reads a zoneless date-time as
#: **local** time while Python's ``fromisoformat`` returns a **naive** datetime, so the
#: same string would mean different instants in the two packages. Both pin it to UTC.
_ZONELESS_ISO = re.compile(r"^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?$")


def _as_datetime(value: Any) -> datetime | None:
    text = _as_string(value)
    if text is None:
        return None
    trimmed = text.strip()
    try:
        parsed = datetime.fromisoformat(trimmed.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None and _ZONELESS_ISO.match(trimmed):
        return parsed.replace(tzinfo=timezone.utc)
    return parsed


def as_money(value: Any, currency: Any = "NGN") -> Money | None:
    """A Fincra amount -- a decimal in major units -- as integer minor units.

    Returns None rather than raising on a value that is absent, negative, or carries more
    precision than the currency has. That last case is routine here rather than
    theoretical: Fincra reports ``fee: 9090.909091`` and balances like ``4145.558824``,
    and reporting those as a rounded number of kobo would state a figure Fincra never gave.
    """
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        major = float(value)
    elif isinstance(value, str) and value.strip() != "":
        try:
            major = float(value)
        except ValueError:
            return None
    else:
        return None

    if not math.isfinite(major) or major < 0:
        return None

    code = (_as_string(currency) or "NGN").upper()
    try:
        return from_major(major, code)
    except MoneyError:
        return None


@dataclass(frozen=True, slots=True)
class Customer:
    email: str | None
    name: str | None
    phone: str | None
    provider_customer_code: str | None


def _to_customer(value: Any) -> Customer | None:
    bag = _as_record(value)
    email = _as_string(bag.get("email"))
    # Fincra names a customer in three ways depending on the endpoint: `name` on a
    # checkout, firstName/lastName on a beneficiary, accountHolderName on a payout.
    first = _as_string(bag.get("firstName"))
    last = _as_string(bag.get("lastName"))
    joined = " ".join(part for part in (first, last) if part) or None
    name = _as_string(bag.get("name")) or _as_string(bag.get("accountHolderName")) or joined
    phone = _as_string(bag.get("phoneNumber")) or _as_string(bag.get("phone"))
    code = _as_string(bag.get("_id")) or _as_string(bag.get("id"))
    if not email and not name and not phone:
        return None
    return Customer(email=email, name=name, phone=phone, provider_customer_code=code)


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
    #: Fincra's own code, authoritative for calling Fincra. Never substituted.
    bank_code: str | None
    #: Fincra's own id for the bank, from GET /core/banks.
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
        provider=FINCRA_PROVIDER_NAME,
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
    #: Your own reference -- Fincra's ``merchantReference``.
    reference: str
    #: Fincra's own ``reference``, e.g. ``fcr-p-700ju9sf``.
    provider_reference: str
    status: str
    amount: Money | None
    #: What the money became after conversion, when the customer paid in another currency.
    #:
    #: Fincra is a cross-border provider, so this is routine rather than exotic, and it is
    #: not the same as ``amount``.
    converted_amount: Money | None
    fees: Money | None
    channel: str | None
    channels: tuple[str, ...]
    paid_at: datetime | None
    created_at: datetime | None
    customer: Customer | None
    fee_bearer: str | None
    provider: str
    raw: Any


def to_transaction(data: Any) -> Transaction:
    bag = _as_record(data)
    currency = _as_string(bag.get("currency")) or "NGN"

    raw_methods = bag.get("paymentMethods")
    methods: list[Any] = raw_methods if isinstance(raw_methods, list) else []
    channels: list[str] = []
    for method in methods:
        channel = normalise_channel(method)
        if channel is not None and channel not in channels:
            channels.append(channel)

    return Transaction(
        reference=_as_string(bag.get("merchantReference"))
        or _as_string(bag.get("customerReference"))
        or "",
        provider_reference=_as_string(bag.get("reference")) or "",
        status=normalise_status(bag.get("status")),
        amount=as_money(bag.get("amount"), currency),
        converted_amount=as_money(
            bag.get("convertedAmount"), _as_string(bag.get("convertedCurrency")) or currency
        ),
        fees=as_money(bag.get("fee"), currency),
        channel=normalise_channel(
            bag.get("defaultPaymentMethod")
            if bag.get("defaultPaymentMethod") is not None
            else bag.get("paymentMethod")
        ),
        channels=tuple(channels),
        paid_at=_as_datetime(
            bag.get("updatedAt") if bag.get("updatedAt") is not None else bag.get("valuedAt")
        ),
        created_at=_as_datetime(bag.get("createdAt")),
        customer=_to_customer(bag.get("customer")),
        fee_bearer=_as_string(bag.get("feeBearer")),
        provider=FINCRA_PROVIDER_NAME,
        raw=data,
    )


@dataclass(frozen=True, slots=True)
class VirtualAccount:
    #: Your own ``merchantReference``, when you set one.
    reference: str
    #: Fincra's ``_id``, which is what every other virtual-account call takes.
    id: str | None
    accounts: tuple[BankAccount, ...]
    kind: str
    status: str
    customer: Customer | None
    #: Fincra's own request status, mapped onto ours. ``approved`` is the only one that
    #: means the account is usable.
    kyc_status: str
    currency: str | None
    #: ``individual`` or ``corporate``.
    account_type: str | None
    expires_at: datetime | None
    created_at: datetime | None
    provider: str
    raw: Any


def _to_accounts(bag: dict[str, Any]) -> tuple[BankAccount, ...]:
    """The one NUBAN on a Fincra virtual account.

    Fincra nests it under ``accountInformation``, except on the temporary-account
    response, where the number is at the top level. No account number means no account.
    """
    info = _as_record(bag.get("accountInformation"))
    account_number = _as_string(info.get("accountNumber")) or _as_string(bag.get("accountNumber"))
    if not account_number:
        return ()
    return (
        enrich(
            account_number=account_number,
            account_name=_as_string(info.get("accountName")) or "",
            bank_name=_as_string(info.get("bankName")),
            bank_code=_as_string(info.get("bankCode")),
        ),
    )


def _to_kind(bag: dict[str, Any], kind: str | None, expires_at: datetime | None) -> str:
    """Static or dynamic.

    ``isPermanent`` is Fincra's own flag and is authoritative. The caller's intent and the
    expiry are only consulted when it is absent, and an account with no expiry is treated
    as static because that is what a permanent account looks like.
    """
    if bag.get("isPermanent") is True:
        return "static"
    if bag.get("isPermanent") is False:
        return "dynamic"
    if kind is not None:
        return kind
    return "static" if expires_at is None else "dynamic"


def to_virtual_account(
    data: Any, *, reference: str | None = None, kind: str | None = None
) -> VirtualAccount:
    bag = _as_record(data)
    accounts = _to_accounts(bag)
    status = (_as_string(bag.get("status")) or "").strip().lower()
    expires_at = _as_datetime(bag.get("expiresAt"))
    resolved_kind = _to_kind(bag, kind, expires_at)

    return VirtualAccount(
        reference=reference or _as_string(bag.get("merchantReference")) or "",
        id=_as_string(bag.get("_id")),
        accounts=accounts,
        kind=resolved_kind,
        # Two separate flags, and an account is only usable when both agree: Fincra can
        # suspend an account that is still marked active.
        status=(
            "inactive"
            if bag.get("isActive") is False or bag.get("isSuspended") is True
            else "active"
        ),
        customer=_to_customer(bag.get("KYCInformation")),
        kyc_status=_VA_STATUS_MAP.get(status, "pending"),
        currency=_as_string(bag.get("currency")),
        account_type=_as_string(bag.get("accountType")),
        expires_at=expires_at,
        created_at=_as_datetime(bag.get("createdAt")),
        provider=FINCRA_PROVIDER_NAME,
        raw=data,
    )


@dataclass(frozen=True, slots=True)
class Payout:
    #: Your own ``customerReference``.
    reference: str
    #: Fincra's own ``reference``.
    provider_reference: str
    status: str
    #: What left your balance -- Fincra's ``amountSent``.
    amount: Money | None
    #: What the beneficiary receives, in the destination currency.
    amount_received: Money | None
    fee: Money | None
    recipient: BankAccount | None
    failure_reason: str | None
    recipient_id: str | None
    #: True when Fincra is waiting for a document before it will process the payout.
    #:
    #: Nothing moves until the document is uploaded, so this is Fincra's equivalent of
    #: Monnify's OTP gate: a payout that looks accepted and is not going anywhere.
    awaiting_document: bool
    documents_required: tuple[str, ...]
    source_currency: str | None
    destination_currency: str | None
    created_at: datetime | None
    provider: str
    raw: Any


def to_payout(data: Any) -> Payout:
    bag = _as_record(data)
    source = _as_string(bag.get("sourceCurrency")) or "NGN"
    destination = _as_string(bag.get("destinationCurrency")) or source
    recipient = _as_record(
        bag.get("recipient") if bag.get("recipient") is not None else bag.get("beneficiary")
    )

    account_number = _as_string(recipient.get("accountNumber"))
    joined = " ".join(
        part
        for part in (_as_string(recipient.get("firstName")), _as_string(recipient.get("lastName")))
        if part
    )
    holder = (
        _as_string(recipient.get("accountHolderName"))
        or _as_string(recipient.get("name"))
        or joined
    )

    raw_documents_value = bag.get("documentsRequired")
    raw_documents: list[Any] = raw_documents_value if isinstance(raw_documents_value, list) else []
    documents = tuple(
        text for text in (_as_string(entry) for entry in raw_documents) if text is not None
    )

    amount_value = bag.get("amountSent")
    if amount_value is None:
        amount_value = bag.get("amountCharged")
    if amount_value is None:
        amount_value = bag.get("amount")

    return Payout(
        reference=_as_string(bag.get("customerReference")) or "",
        provider_reference=_as_string(bag.get("reference")) or "",
        status=normalise_payout_status(bag.get("status")),
        amount=as_money(amount_value, source),
        amount_received=as_money(bag.get("amountReceived"), destination),
        fee=as_money(bag.get("fee"), _as_string(bag.get("feeCurrency")) or source),
        recipient=(
            None
            if account_number is None
            else enrich(
                account_number=account_number,
                account_name=holder or "",
                bank_name=_as_string(recipient.get("bankName")),
                bank_code=_as_string(recipient.get("bankCode")),
            )
        ),
        # Fincra puts the human explanation in `message` and the business one in `reason`,
        # and which is populated depends on the endpoint.
        failure_reason=_as_string(bag.get("reason")) or _as_string(bag.get("message")),
        recipient_id=_as_string(recipient.get("_id")) or _as_string(recipient.get("id")),
        # Fincra sends this as 0/1 on some endpoints and true/false on others.
        awaiting_document=bag.get("isDocumentRequired") is True
        or bag.get("isDocumentRequired") == 1,
        documents_required=documents,
        source_currency=_as_string(bag.get("sourceCurrency")),
        destination_currency=_as_string(bag.get("destinationCurrency")),
        created_at=_as_datetime(bag.get("createdAt")),
        provider=FINCRA_PROVIDER_NAME,
        raw=data,
    )


@dataclass(frozen=True, slots=True)
class Refund:
    reference: str
    provider_reference: str
    collection_reference: str | None
    status: str
    amount: Money | None
    #: Why Fincra is refunding: ``overpayment``, ``underpayment`` or a fixed variance.
    reason: str | None
    destination: BankAccount | None
    provider: str
    raw: Any


def to_refund(data: Any) -> Refund:
    bag = _as_record(data)
    payee = _as_record(bag.get("payee"))
    raw_status = _as_string(bag.get("refundStatus")) or _as_string(bag.get("status"))
    status = _REFUND_STATUS_MAP.get((raw_status or "").strip().lower(), "pending")

    account_number = _as_string(payee.get("accountNumber")) or _as_string(
        bag.get("payeeAccountNumber")
    )

    return Refund(
        reference=_as_string(bag.get("collectionMerchantReference")) or "",
        provider_reference=_as_string(bag.get("reference")) or "",
        collection_reference=_as_string(bag.get("collectionReference")),
        status=status,
        amount=as_money(bag.get("amountRefunded"), _as_string(bag.get("currency")) or "NGN"),
        reason=_as_string(bag.get("refundType")) or _as_string(bag.get("collectionVarianceType")),
        destination=(
            None
            if account_number is None
            else enrich(
                account_number=account_number,
                account_name="",
                bank_name=_as_string(payee.get("bankName")),
                bank_code=_as_string(payee.get("bankCode")),
            )
        ),
        provider=FINCRA_PROVIDER_NAME,
        raw=data,
    )


@dataclass(frozen=True, slots=True)
class WalletBalance:
    currency: str
    available: Money | None
    ledger: Money | None
    #: Money committed to payouts that have not settled.
    locked: Money | None
    wallet_number: str | None
    status: str | None
    provider: str
    raw: Any


def to_wallet_balance(data: Any) -> WalletBalance:
    bag = _as_record(data)
    currency = _as_string(bag.get("currency")) or "NGN"
    return WalletBalance(
        currency=currency,
        available=as_money(bag.get("availableBalance"), currency),
        ledger=as_money(bag.get("ledgerBalance"), currency),
        locked=as_money(bag.get("lockedBalance"), currency),
        wallet_number=_as_string(bag.get("walletNumber")),
        status=_as_string(bag.get("status")),
        provider=FINCRA_PROVIDER_NAME,
        raw=data,
    )


@dataclass(frozen=True, slots=True)
class Bank:
    name: str
    #: Fincra's code, which is what a payout's ``bankCode`` must be.
    code: str
    id: str | None
    #: The NIBSS code, where Fincra publishes it. Fincra is the only Tier 1 provider that
    #: returns the NIP code alongside its own.
    nip_code: str | None
    swift_code: str | None
    is_mobile_money: bool
    is_cash_pickup: bool
    provider: str
    raw: Any


def to_bank(data: Any) -> Bank:
    bag = _as_record(data)
    return Bank(
        name=_as_string(bag.get("name")) or "",
        code=_as_string(bag.get("code")) or "",
        id=_as_string(bag.get("id")),
        nip_code=_as_string(bag.get("nibssCode")),
        swift_code=_as_string(bag.get("swiftCode")) or _as_string(bag.get("bic")),
        is_mobile_money=bag.get("isMobileVerified") is True,
        is_cash_pickup=bag.get("isCashPickUp") is True,
        provider=FINCRA_PROVIDER_NAME,
        raw=data,
    )


@dataclass(frozen=True, slots=True)
class BvnVerification:
    verified: bool
    first_name: str | None
    middle_name: str | None
    last_name: str | None
    gender: str | None
    #: Fincra's own string, e.g. ``15-Jul-2022``. Not parsed.
    date_of_birth: str | None
    phone: str | None
    provider: str
    #: The raw payload **with the photograph removed**.
    #:
    #: Fincra returns ``pixBase64``, a photograph of the person. Carrying it in ``raw``
    #: would put biometric data into every log line and error report that touches this
    #: object, so it is dropped here. NDPA 2023 treats a photograph as personal data.
    raw: Any


def to_bvn_verification(data: Any) -> BvnVerification:
    bag = _as_record(data)
    response = _as_record(bag.get("response"))

    # Copied without pixBase64, so the photograph never reaches `raw`.
    safe_response = {key: value for key, value in response.items() if key != "pixBase64"}

    return BvnVerification(
        verified=(_as_string(bag.get("verificationStatus")) or "").lower() == "verified",
        first_name=_as_string(response.get("firstName")),
        middle_name=_as_string(response.get("middleName")),
        last_name=_as_string(response.get("lastName")),
        gender=_as_string(response.get("gender")),
        date_of_birth=_as_string(response.get("dateOfBirth")),
        phone=_as_string(response.get("phoneNo")),
        provider=FINCRA_PROVIDER_NAME,
        raw={**bag, "response": safe_response},
    )


T = TypeVar("T")


@dataclass(frozen=True, slots=True)
class Page(Generic[T]):
    """A Fincra list page.

    Fincra pages as ``{results, total}`` on some endpoints and as a bare array on others,
    so both are accepted and reported the same way.
    """

    items: tuple[T, ...]
    total: int
    raw: Any


def to_page(data: Any, map_item: Callable[[Any], T]) -> Page[T]:
    if isinstance(data, list):
        items = tuple(map_item(item) for item in data)
        return Page(items=items, total=len(items), raw=data)

    bag = _as_record(data)
    raw_results = bag.get("results")
    results: list[Any] = raw_results if isinstance(raw_results, list) else []
    items = tuple(map_item(item) for item in results)
    total = bag.get("total")
    return Page(
        items=items,
        total=total if isinstance(total, int) and not isinstance(total, bool) else len(items),
        raw=data,
    )


__all__ = [
    "Bank",
    "BankAccount",
    "BvnVerification",
    "Customer",
    "Institution",
    "Page",
    "Payout",
    "Refund",
    "Transaction",
    "TransactionStatus",
    "VirtualAccount",
    "WalletBalance",
    "as_money",
    "enrich",
    "normalise_channel",
    "normalise_payout_status",
    "normalise_status",
    "to_bank",
    "to_bvn_verification",
    "to_page",
    "to_payout",
    "to_refund",
    "to_transaction",
    "to_virtual_account",
    "to_wallet_balance",
]
