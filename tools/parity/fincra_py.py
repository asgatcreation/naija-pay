"""The Fincra half of the Python parity runner.

Mirrors ``tools/parity/fincra-ts.mjs`` exactly: same cases, same flattening, same key
names, so ``tools/check-parity.mjs`` can compare the two byte for byte.

Fincra is where the money boundary is widest: it reports fees like ``9090.909091`` and
balances like ``4145.558824``, amounts no currency can represent, and both packages must
refuse exactly those and accept exactly the rest. Its refund timestamps are also zoneless
(``"2023-12-07 17:39:00"``), the shape Python's ``fromisoformat`` returns naive and
JavaScript reads as local time. ``major_to_string`` is included because Fincra's
temporary-virtual-account endpoint types ``amount`` as a string, where ``str(350.0)`` and
``String(350)`` do not agree.
"""

from __future__ import annotations

import json
import pathlib
from datetime import datetime, timezone
from typing import Any

from naija_pay.core.money import major_to_string, money
from naija_pay.providers.fincra.normalise import (
    as_money,
    normalise_channel,
    normalise_payout_status,
    normalise_status,
    to_bank,
    to_bvn_verification,
    to_payout,
    to_refund,
    to_transaction,
    to_virtual_account,
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
        "convertedAmount": _money(t.converted_amount),
        "fees": _money(t.fees),
        "channel": t.channel,
        "channels": list(t.channels),
        "paidAt": _date(t.paid_at),
        "createdAt": _date(t.created_at),
        "customer": _customer(t.customer),
        "feeBearer": t.fee_bearer,
        "provider": t.provider,
    }


def _virtual_account(v: Any) -> dict[str, Any]:
    return {
        "reference": v.reference,
        "id": v.id,
        "accounts": [_bank_account(a) for a in v.accounts],
        "kind": v.kind,
        "status": v.status,
        "customer": _customer(v.customer),
        "kycStatus": v.kyc_status,
        "currency": v.currency,
        "accountType": v.account_type,
        "expiresAt": _date(v.expires_at),
        "createdAt": _date(v.created_at),
        "provider": v.provider,
    }


def _payout(p: Any) -> dict[str, Any]:
    return {
        "reference": p.reference,
        "providerReference": p.provider_reference,
        "status": p.status,
        "amount": _money(p.amount),
        "amountReceived": _money(p.amount_received),
        "fee": _money(p.fee),
        "recipient": _bank_account(p.recipient),
        "failureReason": p.failure_reason,
        "recipientId": p.recipient_id,
        "awaitingDocument": p.awaiting_document,
        "documentsRequired": list(p.documents_required),
        "sourceCurrency": p.source_currency,
        "destinationCurrency": p.destination_currency,
        "createdAt": _date(p.created_at),
        "provider": p.provider,
    }


def _refund(r: Any) -> dict[str, Any]:
    return {
        "reference": r.reference,
        "providerReference": r.provider_reference,
        "collectionReference": r.collection_reference,
        "status": r.status,
        "amount": _money(r.amount),
        "reason": r.reason,
        "destination": _bank_account(r.destination),
        "provider": r.provider,
    }


def _wallet_balance(b: Any) -> dict[str, Any]:
    return {
        "currency": b.currency,
        "available": _money(b.available),
        "ledger": _money(b.ledger),
        "locked": _money(b.locked),
        "walletNumber": b.wallet_number,
        "status": b.status,
        "provider": b.provider,
    }


def _bank(b: Any) -> dict[str, Any]:
    return {
        "name": b.name,
        "code": b.code,
        "id": b.id,
        "nipCode": b.nip_code,
        "swiftCode": b.swift_code,
        "isMobileMoney": b.is_mobile_money,
        "isCashPickup": b.is_cash_pickup,
        "provider": b.provider,
    }


def _bvn(v: Any) -> dict[str, Any]:
    return {
        "verified": v.verified,
        "firstName": v.first_name,
        "middleName": v.middle_name,
        "lastName": v.last_name,
        "gender": v.gender,
        "dateOfBirth": v.date_of_birth,
        "phone": v.phone,
        "provider": v.provider,
        # The photograph must be absent from `raw` in both languages, which is a privacy
        # guarantee rather than a formatting detail.
        "rawHasPhotograph": "pixBase64" in json.dumps(v.raw),
    }


_CONVERT: dict[str, tuple[Any, Any]] = {
    "transaction": (to_transaction, _transaction),
    "virtual_account": (lambda data: to_virtual_account(data), _virtual_account),
    "payout": (to_payout, _payout),
    "refund": (to_refund, _refund),
    "wallet_balance": (to_wallet_balance, _wallet_balance),
    "bank": (to_bank, _bank),
    "bvn": (to_bvn_verification, _bvn),
}


def fincra_parity(root: pathlib.Path, cases: dict[str, Any]) -> dict[str, Any]:
    base = root / "fixtures" / "providers" / "fincra"

    results = []
    for case in cases["fincraNormalise"]:
        response = json.loads(
            (base / case["fixture"] / "response.json").read_text(encoding="utf-8")
        )
        # Fincra always wraps its payload in `data`. A payload that is a list is
        # normalised from its first element, which is enough to pin the shape.
        data = response.get("data")
        payload = data[0] if isinstance(data, list) else data
        convert, flatten = _CONVERT[case["shape"]]
        results.append(
            {
                "fixture": case["fixture"],
                "shape": case["shape"],
                "value": flatten(convert(payload)),
            }
        )

    major_strings = []
    for case in cases["majorToString"]:
        try:
            major_strings.append(
                {"ok": True, "value": major_to_string(money(case["amount"], case["currency"]))}
            )
        # Broad on purpose: the exact message is what the two languages are compared on.
        except Exception as error:
            major_strings.append({"ok": False, "error": str(error)})

    return {
        "fincraNormalise": results,
        "fincraStatuses": [normalise_status(s) for s in cases["fincraStatuses"]],
        "fincraPayoutStatuses": [normalise_payout_status(s) for s in cases["fincraPayoutStatuses"]],
        "fincraChannels": [normalise_channel(c) for c in cases["fincraChannels"]],
        "fincraAmounts": [
            _money(as_money(case["value"], case.get("currency", "NGN")))
            for case in cases["fincraAmounts"]
        ],
        "majorToString": major_strings,
    }
