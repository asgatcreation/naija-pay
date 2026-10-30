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


def canonical(value: Any) -> Any:
    """Sort mapping keys recursively so key order can never cause a false difference."""
    if isinstance(value, dict):
        return {k: canonical(value[k]) for k in sorted(value)}
    if isinstance(value, (list, tuple)):
        return [canonical(v) for v in value]
    return value


sys.stdout.write(json.dumps(canonical(out), indent=2, ensure_ascii=False) + "\n")
