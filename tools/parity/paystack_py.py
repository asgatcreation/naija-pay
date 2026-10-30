"""The Paystack half of the Python parity runner.

Normalises each recorded fixture and flattens the result into plain JSON, so it can be
compared with the TypeScript output byte for byte. Money becomes ``{amount, currency}``
and dates become ISO strings, because those are the two places the languages would
otherwise differ for uninteresting reasons.
"""

from __future__ import annotations

import json
import pathlib
from datetime import datetime
from typing import Any

from naija_pay.providers.paystack.normalise import (
    normalise_channel,
    normalise_status,
    normalise_transfer_status,
    to_payout,
    to_refund,
    to_split,
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
    from datetime import timezone

    utc = value.astimezone(timezone.utc)
    return f"{utc.strftime('%Y-%m-%dT%H:%M:%S')}.{utc.microsecond // 1000:03d}Z"


def _customer(value: Any) -> dict[str, Any] | None:
    if value is None:
        return None
    return {
        "email": value.email,
        "name": value.name,
        "phone": value.phone,
        "providerCustomerCode": value.provider_customer_code,
    }


def _bank_account(value: Any) -> dict[str, Any] | None:
    if value is None:
        return None
    institution = value.institution
    return {
        "accountNumber": value.account_number,
        "accountName": value.account_name,
        "bankName": value.bank_name,
        "bankCode": value.bank_code,
        "bankSlug": value.bank_slug,
        "provider": value.provider,
        "institution": (
            {
                "id": institution.id,
                "name": institution.name,
                "type": institution.type,
                "nipCode": institution.nip_code,
                "cbnCode": institution.cbn_code,
                "status": institution.status,
                "mergedInto": institution.merged_into,
                "unverifiedCodes": sorted(institution.unverified_codes),
                "matchedBy": institution.matched_by,
            }
            if institution
            else None
        ),
        "mergerWarning": value.merger_warning,
    }


def _transaction(t: Any) -> dict[str, Any]:
    return {
        "reference": t.reference,
        "providerReference": t.provider_reference,
        "status": t.status,
        "amount": _money(t.amount),
        "amountPaid": _money(t.amount_paid),
        "fees": _money(t.fees),
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
        "provider": t.provider,
    }


def _virtual_account(v: Any) -> dict[str, Any]:
    return {
        "reference": v.reference,
        "kind": v.kind,
        "status": v.status,
        "kycStatus": v.kyc_status,
        "provider": v.provider,
        "accounts": [_bank_account(a) for a in v.accounts],
        "customer": _customer(v.customer),
    }


def _payout(p: Any) -> dict[str, Any]:
    return {
        "reference": p.reference,
        "providerReference": p.provider_reference,
        "status": p.status,
        "amount": _money(p.amount),
        "recipientId": p.recipient_id,
        "awaitingOtp": p.awaiting_otp,
        "provider": p.provider,
    }


def _refund(r: Any) -> dict[str, Any]:
    return {
        "providerReference": r.provider_reference,
        "transactionReference": r.transaction_reference,
        "status": r.status,
        "amount": _money(r.amount),
        "provider": r.provider,
    }


def _split_account(s: Any) -> dict[str, Any]:
    return {
        "code": s.code,
        "businessName": s.business_name,
        "settlementAccount": _bank_account(s.settlement_account),
        "percentageCharge": s.percentage_charge,
        "verified": s.verified,
        "provider": s.provider,
    }


def _split(s: Any) -> dict[str, Any]:
    return {
        "code": s.code,
        "name": s.name,
        "type": s.type,
        "currency": s.currency,
        "parties": [{"account": p["account"], "share": p["share"]} for p in s.parties],
        "provider": s.provider,
    }


_CONVERT = {
    "transaction": (to_transaction, _transaction),
    "virtual_account": (to_virtual_account, _virtual_account),
    "payout": (to_payout, _payout),
    "refund": (to_refund, _refund),
    "split_account": (to_split_account, _split_account),
    "split": (to_split, _split),
}


def paystack_parity(root: pathlib.Path, cases: dict[str, Any]) -> dict[str, Any]:
    base = root / "fixtures" / "providers" / "paystack"

    results = []
    for case in cases["paystackNormalise"]:
        response = json.loads(
            (base / case["fixture"] / "response.json").read_text(encoding="utf-8")
        )
        convert, flatten = _CONVERT[case["shape"]]
        results.append(
            {
                "fixture": case["fixture"],
                "shape": case["shape"],
                "value": flatten(convert(response.get("data"))),
            }
        )

    return {
        "paystackNormalise": results,
        "paystackStatuses": [normalise_status(s) for s in cases["paystackStatuses"]],
        "paystackTransferStatuses": [
            normalise_transfer_status(s) for s in cases["paystackTransferStatuses"]
        ],
        "paystackChannels": [normalise_channel(c) for c in cases["paystackChannels"]],
    }
