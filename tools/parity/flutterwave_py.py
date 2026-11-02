"""The Flutterwave half of the Python parity runner.

Normalises each recorded fixture and flattens the result into plain JSON, so it can be
compared with the TypeScript output byte for byte. Money becomes ``{amount, currency}``
and dates become ISO strings, because those are the two places the languages would
otherwise differ for uninteresting reasons.

Flutterwave is the first adapter whose wire format is decimal rather than minor units,
so these cases are also the cross-language check that both languages convert ``20000.5``
to the same 2,000,050 kobo and refuse the same values.
"""

from __future__ import annotations

import json
import pathlib
from datetime import datetime, timezone
from typing import Any

from naija_pay.core.money import basis_points_to_fraction, money, to_major
from naija_pay.providers.flutterwave.normalise import (
    normalise_channel,
    normalise_status,
    normalise_transfer_status,
    to_payout,
    to_refund,
    to_split_account,
    to_transaction,
    to_virtual_account,
    to_wallet_account,
    to_wallet_balance,
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
        "transactionId": t.transaction_id,
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
        "orderReference": v.order_reference,
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
        "flatCharge": _money(s.flat_charge),
        "verified": s.verified,
        "provider": s.provider,
    }


def _wallet_account(w: Any) -> dict[str, Any]:
    return {
        "reference": w.reference,
        "barterId": w.barter_id,
        "accountName": w.account_name,
        "email": w.email,
        "status": w.status,
        "account": _bank_account(w.account),
        "provider": w.provider,
    }


def _wallet_balance(b: Any) -> dict[str, Any]:
    return {
        "reference": b.reference,
        "available": _money(b.available),
        "ledger": _money(b.ledger),
        "provider": b.provider,
    }


_CONVERT: dict[str, tuple[Any, Any]] = {
    "transaction": (to_transaction, _transaction),
    "virtual_account": (to_virtual_account, _virtual_account),
    "payout": (to_payout, _payout),
    "refund": (to_refund, _refund),
    "split_account": (to_split_account, _split_account),
    "wallet_account": (to_wallet_account, _wallet_account),
    "wallet_balance": (lambda data: to_wallet_balance(data, "FALLBACK"), _wallet_balance),
}


def flutterwave_parity(root: pathlib.Path, cases: dict[str, Any]) -> dict[str, Any]:
    base = root / "fixtures" / "providers" / "flutterwave"

    results = []
    for case in cases["flutterwaveNormalise"]:
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

    # The decimal boundary, in both directions. Reported as the exact result or the
    # exact rejection message, so the two languages cannot diverge silently.
    to_major_results = []
    for case in cases["toMajor"]:
        try:
            to_major_results.append(
                {"ok": True, "value": to_major(money(case["amount"], case["currency"]))}
            )
        # Broad on purpose: the exact message is what the two languages are compared on.
        except Exception as error:
            to_major_results.append({"ok": False, "error": str(error)})

    fraction_results = []
    for bps in cases["basisPointsToFraction"]:
        try:
            fraction_results.append({"ok": True, "value": basis_points_to_fraction(bps)})
        # Broad on purpose: the exact message is what the two languages are compared on.
        except Exception as error:
            fraction_results.append({"ok": False, "error": str(error)})

    return {
        "flutterwaveNormalise": results,
        "flutterwaveStatuses": [normalise_status(s) for s in cases["flutterwaveStatuses"]],
        "flutterwaveTransferStatuses": [
            normalise_transfer_status(s) for s in cases["flutterwaveTransferStatuses"]
        ],
        "flutterwaveChannels": [normalise_channel(c) for c in cases["flutterwaveChannels"]],
        "toMajor": to_major_results,
        "basisPointsToFraction": fraction_results,
    }
