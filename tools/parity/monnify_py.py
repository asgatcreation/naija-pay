"""The Monnify half of the Python parity runner.

Mirrors ``tools/parity/monnify-ts.mjs`` exactly: same cases, same flattening, same key
names, so ``tools/check-parity.mjs`` can compare the two byte for byte.

Monnify is the adapter that most needs this check. Its dates are not ISO
(``"25/07/2022 11:20:20 AM"``), and ``createdOn`` is ``"2024-11-25 07:35:17.566"`` --
ISO-shaped with no timezone, which JavaScript reads as local time and Python's
``fromisoformat`` returns as a naive datetime. The same string would otherwise mean
different instants in the two packages. Its webhook scheme was also settled by a hash
Monnify publishes, and that vector is recomputed here so neither language can drift
towards the (wrong) prose on its documentation page.
"""

from __future__ import annotations

import json
import pathlib
from datetime import datetime, timezone
from typing import Any

from naija_pay.core.signatures import SCHEMES, compute_signature
from naija_pay.providers.monnify.normalise import (
    as_money,
    normalise_channel,
    normalise_status,
    normalise_transfer_status,
    parse_monnify_date,
    to_balance,
    to_bank,
    to_bulk_payout,
    to_page,
    to_payout,
    to_refund,
    to_split_account,
    to_transaction,
    to_virtual_account,
)


def _money(value: Any) -> dict[str, Any] | None:
    return None if value is None else {"amount": value.amount, "currency": value.currency}


def _date(value: Any) -> str | None:
    if not isinstance(value, datetime):
        return None
    # Match JavaScript's toISOString: UTC, millisecond precision, trailing Z.
    utc = value.astimezone(timezone.utc)
    return f"{utc.strftime('%Y-%m-%dT%H:%M:%S')}.{utc.microsecond // 1000:03d}Z"


def _bank_account(account: Any) -> dict[str, Any] | None:
    if account is None:
        return None
    institution = account.institution
    return {
        "accountNumber": account.account_number,
        "accountName": account.account_name,
        "bankName": account.bank_name,
        "bankCode": account.bank_code,
        "bankId": account.bank_id,
        "provider": account.provider,
        "institution": (
            {
                "id": institution.id,
                "name": institution.name,
                "type": institution.type,
                "nipCode": institution.nip_code,
                "cbnCode": institution.cbn_code,
                "status": institution.status,
                "mergedInto": institution.merged_into,
                "unverifiedCodes": list(institution.unverified_codes),
                "matchedBy": institution.matched_by,
            }
            if institution
            else None
        ),
        "mergerWarning": account.merger_warning,
    }


def _customer(customer: Any) -> dict[str, Any] | None:
    if customer is None:
        return None
    return {
        "email": customer.email,
        "name": customer.name,
        "phone": customer.phone,
        "providerCustomerCode": customer.provider_customer_code,
    }


def _transaction(t: Any) -> dict[str, Any]:
    return {
        "reference": t.reference,
        "providerReference": t.provider_reference,
        "status": t.status,
        "amount": _money(t.amount),
        "amountPaid": _money(t.amount_paid),
        "fees": _money(t.fees),
        "amountSettled": _money(t.amount_settled),
        "channel": t.channel,
        "paidAt": _date(t.paid_at),
        "createdAt": _date(t.created_at),
        "customer": _customer(t.customer),
        "authorization": (
            {
                "code": t.authorization.code,
                "last4": t.authorization.last4,
                "brand": t.authorization.brand,
                "bank": t.authorization.bank,
                "reusable": t.authorization.reusable,
                "signature": t.authorization.signature,
            }
            if t.authorization
            else None
        ),
        "destinationAccount": _bank_account(t.destination_account),
        "sourceAccount": _bank_account(t.source_account),
        "provider": t.provider,
    }


def _virtual_account(v: Any) -> dict[str, Any]:
    return {
        "reference": v.reference,
        "accounts": [_bank_account(a) for a in v.accounts],
        "kind": v.kind,
        "status": v.status,
        "customer": _customer(v.customer),
        "kycStatus": v.kyc_status,
        "reservationReference": v.reservation_reference,
        "contractCode": v.contract_code,
        "restrictPaymentSource": v.restrict_payment_source,
        "expiresAt": _date(v.expires_at),
        "provider": v.provider,
    }


def _payout(p: Any) -> dict[str, Any]:
    return {
        "reference": p.reference,
        "providerReference": p.provider_reference,
        "status": p.status,
        "amount": _money(p.amount),
        "fee": _money(p.fee),
        "recipient": _bank_account(p.recipient),
        "failureReason": p.failure_reason,
        "recipientId": p.recipient_id,
        "awaitingOtp": p.awaiting_otp,
        "awaitingApproval": p.awaiting_approval,
        "createdAt": _date(p.created_at),
        "provider": p.provider,
    }


def _bulk_payout(b: Any) -> dict[str, Any]:
    return {
        "batchReference": b.batch_reference,
        "status": b.status,
        "totalAmount": _money(b.total_amount),
        "totalFee": _money(b.total_fee),
        "transactionCount": b.transaction_count,
        "successfulCount": b.successful_count,
        "failedCount": b.failed_count,
        "pendingCount": b.pending_count,
        "awaitingOtp": b.awaiting_otp,
        "createdAt": _date(b.created_at),
        "provider": b.provider,
    }


def _refund(r: Any) -> dict[str, Any]:
    return {
        "reference": r.reference,
        "providerReference": r.provider_reference,
        "transactionReference": r.transaction_reference,
        "status": r.status,
        "amount": _money(r.amount),
        "destination": _bank_account(r.destination),
        "provider": r.provider,
    }


def _split_account(s: Any) -> dict[str, Any]:
    return {
        "code": s.code,
        "businessName": s.business_name,
        "settlementAccount": _bank_account(s.settlement_account),
        "defaultShareBasisPoints": s.default_share_basis_points,
        "email": s.email,
        "provider": s.provider,
    }


def _bank(b: Any) -> dict[str, Any]:
    return {
        "name": b.name,
        "code": b.code,
        "ussdTemplate": b.ussd_template,
        "baseUssdCode": b.base_ussd_code,
        "transferUssdTemplate": b.transfer_ussd_template,
        "provider": b.provider,
    }


def _balance(b: Any) -> dict[str, Any]:
    return {
        "accountNumber": b.account_number,
        "available": _money(b.available),
        "ledger": _money(b.ledger),
        "provider": b.provider,
    }


def _page(p: Any) -> dict[str, Any]:
    return {
        "page": p.page,
        "pageSize": p.page_size,
        "total": p.total,
        "totalPages": p.total_pages,
        "hasMore": p.has_more,
        "items": [_transaction(item) for item in p.items],
    }


_CONVERT: dict[str, tuple[Any, Any]] = {
    "transaction": (to_transaction, _transaction),
    "virtual_account": (to_virtual_account, _virtual_account),
    "payout": (to_payout, _payout),
    "bulk_payout": (to_bulk_payout, _bulk_payout),
    "refund": (to_refund, _refund),
    "split_account": (to_split_account, _split_account),
    "bank": (to_bank, _bank),
    "balance": (lambda data: to_balance(data, "3934178936"), _balance),
    "page": (lambda data: to_page(data, to_transaction), _page),
}


def monnify_parity(root: pathlib.Path, cases: dict[str, Any]) -> dict[str, Any]:
    base = root / "fixtures" / "providers" / "monnify"

    results = []
    for case in cases["monnifyNormalise"]:
        response = json.loads(
            (base / case["fixture"] / "response.json").read_text(encoding="utf-8")
        )
        # The envelope, except on the one endpoint that returns its payload at the top
        # level. A payload that is a list is normalised from its first element, which is
        # enough to pin the shape.
        envelope = response.get("responseBody", response)
        payload = envelope[0] if isinstance(envelope, list) else envelope
        convert, flatten = _CONVERT[case["shape"]]
        results.append(
            {
                "fixture": case["fixture"],
                "shape": case["shape"],
                "value": flatten(convert(payload)),
            }
        )

    published = json.loads(
        (base / "webhook-successful-transaction" / "published.json").read_text(encoding="utf-8")
    )
    computed = compute_signature(
        scheme=SCHEMES["monnify"],
        body=published["body"].encode("utf-8"),
        secret=published["secret"],
    )

    dates = []
    for value in cases["monnifyDates"]:
        parsed = parse_monnify_date(value)
        dates.append(None if parsed is None else _date(parsed))

    return {
        "monnifyNormalise": results,
        "monnifyStatuses": [normalise_status(s) for s in cases["monnifyStatuses"]],
        "monnifyTransferStatuses": [
            normalise_transfer_status(s) for s in cases["monnifyTransferStatuses"]
        ],
        "monnifyChannels": [normalise_channel(c) for c in cases["monnifyChannels"]],
        "monnifyDates": dates,
        "monnifyAmounts": [
            _money(as_money(case["value"], case.get("currency", "NGN")))
            for case in cases["monnifyAmounts"]
        ],
        "monnifyPublishedSignature": {
            "matchesPublished": computed == published["signature"],
            "computed": computed,
        },
    }
