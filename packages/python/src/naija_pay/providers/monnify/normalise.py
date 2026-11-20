"""Turning Monnify's payloads into naija-pay's.

Kept separate from the client so it can be tested against recorded fixtures with no HTTP
at all, and so the mapping decisions are reviewable in one place. Every normalised object
keeps ``raw``, so nothing Monnify returns is ever lost.

Three things to understand before reading further.

1. **Decimals on the wire, and sometimes decimals in strings.** Monnify sends and accepts
   amounts as decimals in major units -- ``100.0`` means one hundred naira -- and on a
   verify response it sends them as JSON *strings*: ``"amountPaid": "100.00"``. Both go
   through ``as_money``, which converts via ``from_major`` so the conversion is checked
   rather than multiplied by 100 and hoped for.
2. **Dates are not ISO 8601.** ``paidOn`` is ``"25/07/2022 11:20:20 AM"`` -- day-first,
   with a 12-hour clock and no timezone. Parsing that as ISO fails, and parsing it
   leniently can read 25 July as the 7th of the 25th month. It is parsed explicitly below.
3. **The collection status enum is not published.** The spec shows ``PAID`` and
   ``SUCCESSFUL`` and documents the transfer states in prose, but it never lists every
   collection status. Anything unrecognised therefore maps to ``pending``, which is the
   safe direction: ``pending`` means do not give value yet.

Mirrors ``packages/ts/src/providers/monnify/normalise.ts``.
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
from naija_pay.providers.monnify.capabilities import (
    CHANNEL_FROM_MONNIFY,
    MONNIFY_PROVIDER_NAME,
)

TransactionStatus = Literal["pending", "successful", "failed", "abandoned", "reversed"]

#: Monnify's collection statuses, mapped onto ours.
#:
#: ``PAID`` is Monnify's word for a completed collection; ``SUCCESSFUL`` appears in the
#: transaction-search sample for the same thing. ``OVERPAID`` and ``PARTIALLY_PAID`` are
#: not in the spec's examples but are Monnify's documented inflow variances, and both are
#: mapped deliberately:
#:
#: - ``OVERPAID`` is ``successful`` -- the money arrived, and more of it than expected.
#:   The variance is a business decision, which ``core/events.py`` models with
#:   ``classify_inflow``; it is not a reason to withhold the fact that payment succeeded.
#: - ``PARTIALLY_PAID`` is ``pending``, because the amount asked for has not been paid.
#:   Reporting it as successful would be the single most expensive mistake this file
#:   could make.
_STATUS_MAP: dict[str, str] = {
    "paid": "successful",
    "successful": "successful",
    "success": "successful",
    "overpaid": "successful",
    "partially_paid": "pending",
    "pending": "pending",
    "failed": "failed",
    "cancelled": "abandoned",
    "expired": "abandoned",
    "abandoned": "abandoned",
    "reversed": "reversed",
}

#: Monnify's transfer statuses, which the spec does document, and which contain the trap
#: this adapter most needs to absorb.
#:
#: The documented states are ``PENDING``, ``SUCCESS``, ``FAILED``, ``REVERSED``,
#: ``PENDING_AUTHORIZATION`` and ``OTP_EMAIL_DISPATCH_FAILED``.
#:
#: ``PENDING_AUTHORIZATION`` means **no money has moved and none will** until an OTP is
#: submitted -- the same trap Paystack's transfer OTP produced, which the Paystack sandbox
#: run caught. It maps to ``pending``, and ``to_payout`` sets ``awaiting_otp`` so a caller
#: can act on it rather than waiting for a webhook that will never arrive.
#:
#: ``OTP_EMAIL_DISPATCH_FAILED`` is stranger: the transfer is stuck because Monnify could
#: not even send the OTP. Also ``pending``, also ``awaiting_otp``, because resending the
#: OTP is exactly what resolves it.
_TRANSFER_STATUS_MAP: dict[str, str] = {
    "pending": "pending",
    "pending_authorization": "pending",
    "otp_email_dispatch_failed": "pending",
    "success": "successful",
    "successful": "successful",
    "failed": "failed",
    "reversed": "reversed",
    "cancelled": "abandoned",
    "expired": "abandoned",
}

#: Monnify's refund statuses.
#:
#: Unrecognised becomes ``pending`` rather than ``processed``: a refund wrongly reported
#: as complete is a customer told their money is on the way when it is not.
_REFUND_STATUS_MAP: dict[str, str] = {
    "pending": "pending",
    "awaiting_processing": "pending",
    "processing": "processing",
    "in_progress": "processing",
    "completed": "processed",
    "processed": "processed",
    "successful": "processed",
    "success": "processed",
    "failed": "failed",
}


def normalise_status(monnify_status: Any) -> str:
    if not isinstance(monnify_status, str):
        return "pending"
    return _STATUS_MAP.get(monnify_status.strip().lower(), "pending")


def normalise_transfer_status(monnify_status: Any) -> str:
    if not isinstance(monnify_status, str):
        return "pending"
    return _TRANSFER_STATUS_MAP.get(monnify_status.strip().lower(), "pending")


def normalise_channel(monnify_channel: Any) -> str | None:
    if not isinstance(monnify_channel, str):
        return None
    return CHANNEL_FROM_MONNIFY.get(monnify_channel.strip().upper())


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


#: Monnify's own date format: ``dd/MM/yyyy hh:mm:ss a``.
_MONNIFY_DATE = re.compile(
    r"^(\d{2})/(\d{2})/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})\s*([AaPp])\.?[Mm]\.?$"
)

#: An ISO-ish stamp with **no timezone**, which Monnify also sends.
#:
#: ``createdOn`` on a reserved account is ``"2024-11-25 07:35:17.566"`` -- a space instead
#: of a T, milliseconds, and no offset. That shape is a genuine cross-language hazard:
#: JavaScript's ``Date`` reads a zoneless date-time as **local** time, while Python's
#: ``fromisoformat`` returns a **naive** datetime. The same input would then mean
#: different instants in the two packages, and a parity test is the only thing that would
#: ever notice. Both languages therefore pin it to UTC explicitly.
_ZONELESS_ISO = re.compile(r"^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?$")


def parse_monnify_date(value: Any) -> datetime | None:
    """Monnify's date format, parsed explicitly.

    ``"25/07/2022 11:20:20 AM"``. ISO 8601 also appears, in ``createdOn`` and in the
    transaction-search sample, so both are accepted and anything else returns None rather
    than a wrong instant.

    The parsed value is treated as **UTC**. Monnify sends no timezone, and its timestamps
    are West Africa Time (UTC+1), so this is an hour out -- but it is an hour out
    *consistently and knowably*, where guessing the host's local zone would be anywhere
    from eleven hours out depending on who deployed it. ``raw`` keeps Monnify's own string
    for anyone who needs to be exact, and the sandbox harness asks Monnify which zone it
    means.
    """
    text = _as_string(value)
    if text is None:
        return None

    match = _MONNIFY_DATE.match(text.strip())
    if match:
        day, month, year, raw_hour, minute, second, meridiem = match.groups()
        hour = int(raw_hour)
        is_pm = meridiem.lower() == "p"
        # 12 AM is hour 0 and 12 PM is hour 12; both get this wrong if you only add
        # twelve for PM.
        if is_pm and hour != 12:
            hour += 12
        if not is_pm and hour == 12:
            hour = 0
        if hour > 23:
            return None
        try:
            return datetime(
                int(year), int(month), int(day), hour, int(minute), int(second), tzinfo=timezone.utc
            )
        except ValueError:
            # 31/02 and friends. Refused rather than rolled forward into March.
            return None

    trimmed = text.strip()
    try:
        parsed = datetime.fromisoformat(trimmed.replace("Z", "+00:00"))
    except ValueError:
        return None
    # A zoneless stamp is read as UTC, not as a naive datetime: see _ZONELESS_ISO.
    if parsed.tzinfo is None and _ZONELESS_ISO.match(trimmed):
        return parsed.replace(tzinfo=timezone.utc)
    return parsed


def as_money(value: Any, currency: Any = "NGN") -> Money | None:
    """A Monnify amount -- a decimal in major units, as a number or a string.

    Returns None rather than raising on a value that is absent, negative, or carries more
    precision than the currency has. A normaliser is reading somebody else's payload and
    must not take the process down; the adapter surfaces ``raw`` alongside, so nothing is
    hidden.
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
    email = _as_string(bag.get("email")) or _as_string(bag.get("customerEmail"))
    name = _as_string(bag.get("name")) or _as_string(bag.get("customerName"))
    phone = _as_string(bag.get("phoneNumber")) or _as_string(bag.get("customerPhoneNumber"))
    if not email and not name and not phone:
        return None
    # Monnify has no customer object and no customer code; the account reference is the
    # nearest thing and belongs to a reserved account, not to a person.
    return Customer(email=email, name=name, phone=phone, provider_customer_code=None)


@dataclass(frozen=True, slots=True)
class CardAuthorization:
    #: Monnify's reusable card token. Present only when the card supports tokenisation
    #: and the merchant has it enabled; ``supportsTokenization`` and ``reusable`` both
    #: appear on the verify response and are frequently false.
    code: str
    last4: str | None
    brand: str | None
    bank: str | None
    reusable: bool
    #: Monnify publishes no card fingerprint, so this is always None. Stated, not hidden.
    signature: str | None


def _to_authorization(value: Any) -> CardAuthorization | None:
    bag = _as_record(value)
    token = _as_string(bag.get("cardToken"))
    if not token:
        return None
    return CardAuthorization(
        code=token,
        last4=_as_string(bag.get("last4")),
        brand=_as_string(bag.get("cardType")),
        bank=_as_string(bag.get("bankName")),
        reusable=bag.get("reusable") is True,
        signature=None,
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
    #: Monnify's own code, authoritative for calling Monnify. Never substituted.
    bank_code: str | None
    #: Monnify has no numeric bank id; kept for shape parity with the other adapters.
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
        provider=MONNIFY_PROVIDER_NAME,
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


def _to_account_or_none(bag: dict[str, Any]) -> BankAccount | None:
    """Enrich an account only when there is an account number to enrich."""
    if not bag:
        return None
    account_number = _as_string(bag.get("accountNumber"))
    if account_number is None:
        return None
    return enrich(
        account_number=account_number,
        account_name=_as_string(bag.get("accountName")) or "",
        bank_name=_as_string(bag.get("bankName")),
        bank_code=_as_string(bag.get("bankCode")),
    )


@dataclass(frozen=True, slots=True)
class Transaction:
    #: Your own ``paymentReference``.
    reference: str
    #: Monnify's ``transactionReference``, e.g. ``MNFY|67|20220725111957|000283``.
    provider_reference: str
    status: str
    #: What the customer was asked for -- Monnify's ``totalPayable``.
    amount: Money | None
    #: What actually arrived -- ``amountPaid``. Differs on an under- or overpayment.
    amount_paid: Money | None
    fees: Money | None
    #: What reaches your Monnify balance after fees -- ``settlementAmount``.
    amount_settled: Money | None
    channel: str | None
    paid_at: datetime | None
    created_at: datetime | None
    customer: Customer | None
    authorization: CardAuthorization | None
    #: The account the money arrived in, when it came by transfer.
    destination_account: BankAccount | None
    #: Who sent the transfer, when Monnify could tell. Monnify is unusual in reporting
    #: the payer's own account, which is what makes ``restrictPaymentSource`` possible.
    source_account: BankAccount | None
    provider: str
    raw: Any


def to_transaction(data: Any) -> Transaction:
    bag = _as_record(data)
    currency = _as_string(bag.get("currency")) or _as_string(bag.get("currencyCode")) or "NGN"

    # `paymentSourceInformation` is an array on a webhook and an object on a verify
    # response. Monnify is inconsistent here, and both shapes appear in its own samples.
    raw_source = bag.get("paymentSourceInformation")
    source = (
        _as_record(raw_source[0])
        if isinstance(raw_source, list) and raw_source
        else _as_record(raw_source)
    )

    return Transaction(
        reference=_as_string(bag.get("paymentReference")) or "",
        provider_reference=_as_string(bag.get("transactionReference")) or "",
        status=normalise_status(bag.get("paymentStatus")),
        amount=as_money(
            bag.get("totalPayable") if bag.get("totalPayable") is not None else bag.get("amount"),
            currency,
        ),
        amount_paid=as_money(bag.get("amountPaid"), currency),
        fees=as_money(bag.get("fee"), currency),
        amount_settled=as_money(bag.get("settlementAmount"), currency),
        channel=normalise_channel(bag.get("paymentMethod")),
        paid_at=parse_monnify_date(
            bag.get("paidOn") if bag.get("paidOn") is not None else bag.get("completedOn")
        ),
        created_at=parse_monnify_date(
            bag.get("createdOn") if bag.get("createdOn") is not None else bag.get("transactionDate")
        ),
        customer=_to_customer(bag.get("customer") or bag.get("customerDTO") or bag),
        authorization=_to_authorization(bag.get("cardDetails")),
        destination_account=_to_account_or_none(
            _as_record(bag.get("destinationAccountInformation"))
        ),
        source_account=_to_account_or_none(source),
        provider=MONNIFY_PROVIDER_NAME,
        raw=data,
    )


@dataclass(frozen=True, slots=True)
class VirtualAccount:
    #: Your own ``accountReference``.
    reference: str
    #: Every account reserved for this customer.
    #:
    #: Monnify is the only Tier 1 provider that can reserve an account at several partner
    #: banks at once -- ``getAllAvailableBanks: true`` -- so this is a list in practice
    #: and not just in shape.
    accounts: tuple[BankAccount, ...]
    kind: str
    status: str
    customer: Customer | None
    kyc_status: str
    #: Monnify's ``reservationReference``, its own handle for the reservation.
    reservation_reference: str | None
    contract_code: str | None
    #: Whether inflows are restricted to named sources. Monnify's documentation says this
    #: defaults to **true**, which would be unusual and dangerous: a reserved account
    #: created without ``allowedPaymentSources`` would reject the payments you are waiting
    #: for. The sandbox returns **false** when the field is omitted (verified 2026-11-19).
    #: Because the two disagree, the adapter always sends the field rather than relying on
    #: a default, and this is what Monnify reported back.
    restrict_payment_source: bool
    expires_at: datetime | None
    provider: str
    raw: Any


def _to_accounts(bag: dict[str, Any]) -> list[BankAccount]:
    """The NUBANs on a reserved account.

    Two shapes reach this: the v2 route returns an ``accounts`` list, while the v1 invoice
    route returns one flat accountNumber/bankName/bankCode. Both come out as the list, and
    the flat shape is only read when the list gave nothing -- an ``accounts`` entry
    without an account number is not an account.
    """
    accounts: list[BankAccount] = []
    listed = bag.get("accounts")
    if isinstance(listed, list):
        for entry in listed:
            account = _as_record(entry)
            account_number = _as_string(account.get("accountNumber"))
            if account_number is None:
                continue
            accounts.append(
                enrich(
                    account_number=account_number,
                    account_name=_as_string(account.get("accountName"))
                    or _as_string(bag.get("accountName"))
                    or "",
                    bank_name=_as_string(account.get("bankName")),
                    bank_code=_as_string(account.get("bankCode")),
                )
            )
    if accounts:
        return accounts

    flat_number = _as_string(bag.get("accountNumber"))
    if flat_number is None:
        return accounts
    accounts.append(
        enrich(
            account_number=flat_number,
            account_name=_as_string(bag.get("accountName")) or "",
            bank_name=_as_string(bag.get("bankName")),
            bank_code=_as_string(bag.get("bankCode")),
        )
    )
    return accounts


def to_virtual_account(
    data: Any, *, reference: str | None = None, kind: str | None = None
) -> VirtualAccount:
    bag = _as_record(data)
    accounts = _to_accounts(bag)

    status = (_as_string(bag.get("status")) or "").upper()
    bvn = _as_string(bag.get("bvn"))

    return VirtualAccount(
        reference=reference or _as_string(bag.get("accountReference")) or "",
        accounts=tuple(accounts),
        # A reserved account is Monnify's static NUBAN. Its one-off equivalent is a
        # different endpoint, which this adapter does not implement yet.
        kind=kind or "static",
        status="inactive" if status in ("INACTIVE", "DELETED") else "active",
        customer=_to_customer(bag),
        # Monnify reports no KYC verdict on a reserved account: it echoes the BVN it was
        # given. `pending` where one was supplied, `not_required` where none was, and
        # never `verified`, which would be a claim Monnify has not made.
        kyc_status="not_required" if bvn is None else "pending",
        reservation_reference=_as_string(bag.get("reservationReference")),
        contract_code=_as_string(bag.get("contractCode")),
        restrict_payment_source=bag.get("restrictPaymentSource") is True,
        expires_at=parse_monnify_date(bag.get("expiresOn")),
        provider=MONNIFY_PROVIDER_NAME,
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
    #: Monnify has no recipient object; a payout names the account every time.
    recipient_id: str | None
    #: True when Monnify is waiting for an OTP.
    #:
    #: ``PENDING_AUTHORIZATION`` and ``OTP_EMAIL_DISPATCH_FAILED`` both mean no money has
    #: moved and none will until ``authorize_payout`` is called. Two-factor disbursement
    #: is on by default on a new Monnify integration, so this is the normal path rather
    #: than an edge case.
    awaiting_otp: bool
    #: Kept for shape parity with Flutterwave; Monnify has no dashboard approval step.
    awaiting_approval: bool
    created_at: datetime | None
    provider: str
    raw: Any


def to_payout(data: Any) -> Payout:
    bag = _as_record(data)
    currency = _as_string(bag.get("currency")) or "NGN"
    raw_status = (_as_string(bag.get("status")) or "").upper()
    account_number = _as_string(bag.get("destinationAccountNumber"))

    return Payout(
        reference=_as_string(bag.get("reference")) or "",
        provider_reference=_as_string(bag.get("transactionReference"))
        or _as_string(bag.get("reference"))
        or "",
        status=normalise_transfer_status(raw_status),
        amount=as_money(bag.get("amount"), currency),
        fee=as_money(
            bag.get("fee") if bag.get("fee") is not None else bag.get("totalFee"), currency
        ),
        recipient=(
            None
            if account_number is None
            else enrich(
                account_number=account_number,
                account_name=_as_string(bag.get("destinationAccountName")) or "",
                bank_name=_as_string(bag.get("destinationBankName")),
                bank_code=_as_string(bag.get("destinationBankCode")),
            )
        ),
        failure_reason=_as_string(bag.get("transactionDescription")),
        recipient_id=None,
        awaiting_otp=raw_status in ("PENDING_AUTHORIZATION", "OTP_EMAIL_DISPATCH_FAILED"),
        awaiting_approval=False,
        created_at=parse_monnify_date(
            bag.get("dateCreated") if bag.get("dateCreated") is not None else bag.get("createdOn")
        ),
        provider=MONNIFY_PROVIDER_NAME,
        raw=data,
    )


def _as_count(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    return int(value) if isinstance(value, (int, float)) else None


@dataclass(frozen=True, slots=True)
class BulkPayout:
    batch_reference: str
    status: str
    total_amount: Money | None
    total_fee: Money | None
    transaction_count: int | None
    successful_count: int | None
    failed_count: int | None
    pending_count: int | None
    awaiting_otp: bool
    created_at: datetime | None
    provider: str
    raw: Any


def to_bulk_payout(data: Any) -> BulkPayout:
    bag = _as_record(data)
    raw_status = (_as_string(bag.get("batchStatus")) or "").upper()
    return BulkPayout(
        batch_reference=_as_string(bag.get("batchReference")) or "",
        status=normalise_transfer_status(raw_status),
        total_amount=as_money(bag.get("totalAmount")),
        total_fee=as_money(bag.get("totalFee")),
        transaction_count=_as_count(bag.get("totalTransactionsCount")),
        successful_count=_as_count(bag.get("successfulCount")),
        failed_count=_as_count(bag.get("failedCount")),
        pending_count=_as_count(bag.get("pendingCount")),
        awaiting_otp=raw_status in ("PENDING_AUTHORIZATION", "AWAITING_PROCESSING"),
        created_at=parse_monnify_date(bag.get("dateCreated")),
        provider=MONNIFY_PROVIDER_NAME,
        raw=data,
    )


@dataclass(frozen=True, slots=True)
class Refund:
    reference: str
    provider_reference: str
    transaction_reference: str | None
    status: str
    amount: Money | None
    destination: BankAccount | None
    provider: str
    raw: Any


def to_refund(data: Any) -> Refund:
    bag = _as_record(data)
    raw_status = _as_string(bag.get("refundStatus"))
    status = _REFUND_STATUS_MAP.get((raw_status or "").strip().lower(), "pending")
    account_number = _as_string(bag.get("destinationAccountNumber"))

    return Refund(
        reference=_as_string(bag.get("refundReference")) or "",
        provider_reference=_as_string(bag.get("reference"))
        or _as_string(bag.get("refundReference"))
        or "",
        transaction_reference=_as_string(bag.get("transactionReference")),
        status=status,
        amount=as_money(bag.get("refundAmount"), _as_string(bag.get("currencyCode")) or "NGN"),
        destination=(
            None
            if account_number is None
            else enrich(
                account_number=account_number,
                account_name=_as_string(bag.get("destinationAccountName")) or "",
                bank_name=_as_string(bag.get("destinationBankName")),
            )
        ),
        provider=MONNIFY_PROVIDER_NAME,
        raw=data,
    )


@dataclass(frozen=True, slots=True)
class SplitAccount:
    #: Monnify's ``subAccountCode``, e.g. ``MFY_SUB_319452883228``.
    code: str
    business_name: str | None
    settlement_account: BankAccount | None
    #: The sub-account's default share, in basis points.
    #:
    #: Monnify's ``defaultSplitPercentage`` is a percentage -- ``20`` means 20% -- and
    #: our API is basis points, so this is multiplied by 100. A fractional percentage
    #: that cannot be represented in whole basis points is reported as None rather than
    #: rounded, so money is never silently moved between parties.
    default_share_basis_points: int | None
    email: str | None
    provider: str
    raw: Any


def to_split_account(data: Any) -> SplitAccount:
    bag = _as_record(data)
    account_number = _as_string(bag.get("accountNumber"))

    percentage = bag.get("defaultSplitPercentage")
    basis_points: int | None = None
    if isinstance(percentage, (int, float)) and not isinstance(percentage, bool):
        scaled = float(percentage) * 100
        basis_points = round(scaled) if scaled == int(scaled) else None

    return SplitAccount(
        code=_as_string(bag.get("subAccountCode")) or "",
        # Monnify names the settlement account's holder, not a business; `accountName` is
        # the nearest honest field.
        business_name=_as_string(bag.get("accountName")),
        settlement_account=(
            None
            if account_number is None
            else enrich(
                account_number=account_number,
                account_name=_as_string(bag.get("accountName")) or "",
                bank_name=_as_string(bag.get("bankName")),
                bank_code=_as_string(bag.get("bankCode")),
            )
        ),
        default_share_basis_points=basis_points,
        email=_as_string(bag.get("email")),
        provider=MONNIFY_PROVIDER_NAME,
        raw=data,
    )


@dataclass(frozen=True, slots=True)
class Balance:
    account_number: str
    available: Money | None
    ledger: Money | None
    provider: str
    raw: Any


def to_balance(data: Any, account_number: str) -> Balance:
    bag = _as_record(data)
    return Balance(
        account_number=account_number,
        available=as_money(bag.get("availableBalance")),
        ledger=as_money(bag.get("ledgerBalance")),
        provider=MONNIFY_PROVIDER_NAME,
        raw=data,
    )


@dataclass(frozen=True, slots=True)
class Bank:
    name: str
    code: str
    #: Monnify is the only Tier 1 provider that publishes USSD templates per bank.
    ussd_template: str | None
    base_ussd_code: str | None
    transfer_ussd_template: str | None
    provider: str
    raw: Any


def to_bank(data: Any) -> Bank:
    bag = _as_record(data)
    return Bank(
        name=_as_string(bag.get("name")) or "",
        code=_as_string(bag.get("code")) or "",
        ussd_template=_as_string(bag.get("ussdTemplate")),
        base_ussd_code=_as_string(bag.get("baseUssdCode")),
        transfer_ussd_template=_as_string(bag.get("transferUssdTemplate")),
        provider=MONNIFY_PROVIDER_NAME,
        raw=data,
    )


T = TypeVar("T")


@dataclass(frozen=True, slots=True)
class Page(Generic[T]):
    """A Spring ``Page``, which is what Monnify returns from every list endpoint.

    Normalised to the shape the other adapters use, so a caller does not have to know
    that Monnify's backend is Spring. ``last`` is kept as ``has_more`` inverted, because
    a boolean named ``last`` reads as "the last item" rather than "the last page".
    """

    items: tuple[T, ...]
    page: int
    page_size: int
    total: int
    total_pages: int
    has_more: bool
    raw: Any


def to_page(data: Any, map_item: Callable[[Any], T]) -> Page[T]:
    bag = _as_record(data)
    raw_content = bag.get("content")
    content: list[Any] = raw_content if isinstance(raw_content, list) else []
    pageable = _as_record(bag.get("pageable"))

    page_number = _as_count(bag.get("number"))
    if page_number is None:
        page_number = _as_count(pageable.get("pageNumber")) or 0
    page_size = _as_count(bag.get("size"))
    if page_size is None:
        page_size = _as_count(pageable.get("pageSize")) or 0
    total = _as_count(bag.get("totalElements"))
    if total is None:
        total = len(content)

    return Page(
        items=tuple(map_item(item) for item in content),
        page=page_number,
        page_size=page_size,
        total=total,
        total_pages=_as_count(bag.get("totalPages")) or 0,
        # Monnify omits `last` on some list responses, so absence is treated as "no more"
        # rather than looping forever on a paginator that trusts it.
        has_more=bag.get("last") is False,
        raw=data,
    )


__all__ = [
    "Balance",
    "Bank",
    "BankAccount",
    "BulkPayout",
    "CardAuthorization",
    "Customer",
    "Institution",
    "Page",
    "Payout",
    "Refund",
    "SplitAccount",
    "Transaction",
    "TransactionStatus",
    "VirtualAccount",
    "as_money",
    "enrich",
    "normalise_channel",
    "normalise_status",
    "normalise_transfer_status",
    "parse_monnify_date",
    "to_balance",
    "to_bank",
    "to_bulk_payout",
    "to_page",
    "to_payout",
    "to_refund",
    "to_split_account",
    "to_transaction",
    "to_virtual_account",
]
