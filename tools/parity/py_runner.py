#!/usr/bin/env python
"""Runs the shared parity cases through the Python package, printing canonical JSON.

The TypeScript runner does the same, and ``tools/check-parity.mjs`` compares the two
byte for byte.

Nothing is printed except the JSON, so a stray print in the package shows up as a
parity failure rather than being silently tolerated.
"""

from __future__ import annotations

import json
import pathlib
import sys
from typing import Any, Callable

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "packages" / "python" / "src"))

from datetime import datetime, timezone  # noqa: E402

from naija_pay.core.events import InflowRules, decide_inflow  # noqa: E402
from naija_pay.providers.mock import MOCK_SCHEME, mock  # noqa: E402

from naija_pay.core.banks import (  # noqa: E402
    bank_data_source,
    institutions,
    match_institution,
    merger_warning_for,
    normalise_bank_name,
    unverified_codes_for,
)
from naija_pay.core.signatures import (  # noqa: E402
    SCHEMES,
    compute_signature,
    strength_of,
    verify_signature,
)

from naija_pay.core import (  # noqa: E402
    Share,
    error_class_for_status,
    format_money,
    from_major,
    looks_like_live_key,
    looks_like_test_key,
    money,
    redact,
    redact_object,
    split_by_basis_points,
    split_by_flat_amounts,
)

CASES = json.loads((ROOT / "fixtures" / "parity" / "core.json").read_text(encoding="utf-8"))

#: The two languages name the same failure differently by default -- Python's
#: MoneyError is a ValueError, TypeScript's is an Error subclass -- so parity compares
#: the class name, which we keep identical by design.
ERROR_NAMES = {"MoneyError": "MoneyError"}


def attempt(fn: Callable[[], Any]) -> dict[str, Any]:
    """Both languages must describe a rejection identically."""
    try:
        return {"ok": True, "value": fn()}
    except Exception as exc:  # noqa: BLE001 - parity output, not control flow
        name = type(exc).__name__
        return {"ok": False, "error": ERROR_NAMES.get(name, name), "message": str(exc)}


def split_out(result: Any) -> dict[str, Any]:
    return {
        "parts": [
            {
                "account": p.account,
                "amount": p.amount.amount,
                "currency": p.amount.currency,
            }
            for p in result.parts
        ],
        "remainder": result.remainder.amount,
    }


def _as_money(m: Any) -> dict[str, Any]:
    return {"amount": m.amount, "currency": m.currency}


out: dict[str, Any] = {}

out["fromMajor"] = [
    attempt(lambda c=c: _as_money(from_major(c["major"], c["currency"])))  # type: ignore[misc]
    for c in CASES["fromMajor"]
]

out["format"] = [
    attempt(lambda c=c: format_money(money(c["amount"], c["currency"])))  # type: ignore[misc]
    for c in CASES["format"]
]

out["splitByBasisPoints"] = [
    attempt(
        lambda c=c: split_out(  # type: ignore[misc]
            split_by_basis_points(
                money(c["total"]["amount"], c["total"]["currency"]),
                [Share(s["account"], s["share"]) for s in c["shares"]],
            )
        )
    )
    for c in CASES["splitByBasisPoints"]
]

out["splitByFlatAmounts"] = [
    attempt(
        lambda c=c: split_out(  # type: ignore[misc]
            split_by_flat_amounts(
                money(c["total"]["amount"], c["total"]["currency"]),
                [Share(s["account"], s["share"]) for s in c["shares"]],
            )
        )
    )
    for c in CASES["splitByFlatAmounts"]
]

out["redact"] = [redact(s) for s in CASES["redact"]]
out["redactObject"] = [redact_object(o) for o in CASES["redactObject"]]
out["keyDetection"] = [
    {"key": k, "live": looks_like_live_key(k), "test": looks_like_test_key(k)}
    for k in CASES["keyDetection"]
]
out["errorForStatus"] = [error_class_for_status(s).__name__ for s in CASES["errorForStatus"]]

signature_results: list[dict[str, Any]] = []
for case in CASES["signatures"]:
    scheme = SCHEMES[case["scheme"]]
    body = case["body"].encode("utf-8")

    computed = attempt(lambda s=scheme, b=body, k=case["secret"]: compute_signature(s, b, k))  # type: ignore[misc]

    # Verify with whatever was computed. For undocumented schemes nothing can be
    # computed, so a fixed placeholder is used and both languages must agree that the
    # result is unverified.
    signature = computed["value"] if computed["ok"] else "cannot-be-computed"
    verification = verify_signature(
        scheme=scheme,
        body=body,
        headers={scheme.header: signature},
        secret=case["secret"],
    )

    # Tampering must be detected identically in both languages.
    tampered = verify_signature(
        scheme=scheme,
        body=(case["body"] + " ").encode("utf-8"),
        headers={scheme.header: signature},
        secret=case["secret"],
    )

    signature_results.append(
        {
            "scheme": case["scheme"],
            "computed": computed,
            "verified": verification.verified,
            "strength": verification.strength,
            "reason": verification.reason,
            "tamperedVerified": tampered.verified,
            "tamperedStrength": tampered.strength,
        }
    )

out["signatures"] = signature_results

out["signatureStrengths"] = [
    {
        "scheme": name,
        "declared": SCHEMES[name].strength,
        "derived": strength_of(SCHEMES[name]),
        "header": SCHEMES[name].header,
        "algorithm": SCHEMES[name].algorithm,
    }
    for name in CASES["signatureStrengths"]
]


out["bankNames"] = [normalise_bank_name(n) for n in CASES["bankNames"]]

bank_matches: list[dict[str, Any]] = []
for probe in CASES["bankMatches"]:
    found = match_institution(code=probe.get("code"), name=probe.get("name"))
    if found is None:
        bank_matches.append({"matched": False})
        continue
    warning = merger_warning_for(found.institution)
    bank_matches.append(
        {
            "matched": True,
            "id": found.institution.id,
            "matchedBy": found.matched_by,
            "name": found.institution.name,
            "type": found.institution.type,
            "status": found.institution.status,
            "nipCode": found.institution.nip_code,
            "cbnCode": found.institution.cbn_code,
            "unverified": sorted(unverified_codes_for(found.institution)),
            "mergerMessage": warning.message if warning else None,
        }
    )

out["bankMatches"] = bank_matches
out["bankDataVersion"] = [bank_data_source().data_version, len(institutions())]


FIXED_NOW = datetime(2026, 10, 30, 12, 0, 0, tzinfo=timezone.utc)
EXPIRED_AT = datetime(2026, 10, 30, 10, 0, 0, tzinfo=timezone.utc)
PAID_LATE_AT = datetime(2026, 10, 30, 10, 20, 0, tzinfo=timezone.utc)


def _ngn(amount: int) -> Any:
    return money(amount, "NGN")


mock_webhooks: list[dict[str, Any]] = []
for case in CASES["mockWebhooks"]:
    provider = mock(now=lambda: FIXED_NOW)
    if case["kind"] == "inflow":
        extra: dict[str, Any] = (
            {"expires_at": EXPIRED_AT, "paid_at": PAID_LATE_AT} if case.get("late") else {}
        )
        webhook = provider.simulate_inflow(
            expected_amount=None if case["expected"] is None else _ngn(case["expected"]),
            amount_paid=_ngn(case["paid"]),
            **extra,
        )
    elif case["kind"] == "payment":
        webhook = provider.simulate_payment(status=case["status"])
    else:
        webhook = provider.simulate_transfer(status=case["status"])

    mock_webhooks.append(
        {
            "text": webhook.text,
            "signature": webhook.headers[MOCK_SCHEME.header],
            "eventId": webhook.event.id,
            "eventType": webhook.event.type,
            "strength": webhook.event.signature_strength,
        }
    )

out["mockWebhooks"] = mock_webhooks

inflow_decisions: list[dict[str, Any]] = []
for case in CASES["inflowDecisions"]:
    rules = None
    if case["rules"]:
        rules = InflowRules(
            overpayment=case["rules"]["overpayment"],
            underpayment=case["rules"]["underpayment"],
            late_payment=case["rules"]["latePayment"],
        )
    decision = decide_inflow(
        variance=case["variance"],
        amount_paid=_ngn(case["paid"]),
        expected_amount=None if case["expected"] is None else _ngn(case["expected"]),
        is_late=case["late"],
        rules=rules,
        already_processed=case["duplicate"],
    )
    inflow_decisions.append(
        {
            "action": decision.action,
            "amount": decision.amount.amount if decision.amount else None,
            "reason": decision.reason,
        }
    )

out["inflowDecisions"] = inflow_decisions


sys.path.insert(0, str(ROOT / "tools" / "parity"))
from paystack_py import paystack_parity  # noqa: E402

out.update(paystack_parity(ROOT, CASES))


def canonical(value: Any) -> Any:
    """Sort mapping keys recursively so key order can never cause a false difference."""
    if isinstance(value, dict):
        return {k: canonical(value[k]) for k in sorted(value)}
    if isinstance(value, (list, tuple)):
        return [canonical(v) for v in value]
    return value


sys.stdout.write(json.dumps(canonical(out), indent=2, ensure_ascii=False) + "\n")
