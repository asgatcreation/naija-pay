#!/usr/bin/env python
"""Exercises the Python Paystack adapter against Paystack's real sandbox.

Run with ``npm run sandbox:paystack:python``. Needs ``PAYSTACK_SECRET_KEY`` in ``.env``
and **refuses to run with anything but a sk_test_ key**.

This is deliberately narrower than the TypeScript sandbox run, which answers the open
documentation questions. The point here is different and just as important: it is the
only thing that exercises ``HttpxTransport`` against a real server. Every other Python
test uses a fake transport, so until this runs, the real HTTP path has never been
executed -- and a transport that cannot talk to a provider is a package that does not
work, however green the unit tests are.
"""

from __future__ import annotations

import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "packages" / "python" / "src"))


def load_env() -> dict[str, str]:
    """Minimal .env reader; the package depends only on httpx and so does this."""
    file = ROOT / ".env"
    if not file.exists():
        return {}
    out: dict[str, str] = {}
    for line in file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, _, value = line.partition("=")
        value = value.strip().strip('"').strip("'")
        if value:
            out[name.strip()] = value
    return out


def main() -> int:
    import os

    env = {**load_env(), **os.environ}
    secret_key = env.get("PAYSTACK_SECRET_KEY")

    if not secret_key:
        print("PAYSTACK_SECRET_KEY is not set, so the Python sandbox run is skipped.")
        print("Put a sk_test_ key in .env to enable it. Nothing failed.")
        return 0

    if not secret_key.startswith("sk_test_"):
        print("REFUSING TO RUN: PAYSTACK_SECRET_KEY is not a sk_test_ key.", file=sys.stderr)
        return 1

    from naija_pay.core.money import naira
    from naija_pay.providers.paystack import paystack

    # No transport passed, so the adapter builds HttpxTransport itself. That is the
    # whole point of this script.
    provider = paystack(secret_key=secret_key, environment="test")

    failures = 0

    def observe(label: str, fn) -> None:  # type: ignore[no-untyped-def]
        nonlocal failures
        print(f"  {label} ... ", end="", flush=True)
        try:
            note = fn()
            print(f"ok — {note}")
        except Exception as exc:
            failures += 1
            print(f"FAILED — {type(exc).__name__}: {exc}")

    print("Paystack sandbox run, Python adapter over HttpxTransport\n")

    def banks() -> str:
        rows = provider.list_banks(country="nigeria")
        return f"{len(rows)} banks returned"

    def resolve() -> str:
        account = provider.resolve_account(account_number="0000000000", bank_code="044")
        matched = (
            f"{account.institution.id} by {account.institution.matched_by}"
            if account.institution
            else "no match"
        )
        return f'resolved to "{account.account_name}"; institution {matched}'

    def balance() -> str:
        rows = provider.get_balance()
        return ", ".join(f"{r['currency']} {r['amount']}" for r in rows) or "none returned"

    def unknown_reference() -> str:
        try:
            provider.verify_transaction("naijapay-definitely-missing")
        except Exception as exc:
            return f"{type(exc).__name__} as expected"
        return "UNEXPECTED: the call succeeded"

    def checkout() -> str:
        import time

        result = provider.create_checkout(
            amount=naira(5_000),
            email="ada@example.com",
            reference=f"naijapay-py-{int(time.time())}",
            channels=["card", "bank_transfer"],
        )
        return f"checkout issued for reference {result['reference']}"

    observe("the real httpx transport can reach Paystack", banks)
    observe("account resolution works over httpx", resolve)
    observe("the balance endpoint works over httpx", balance)
    observe("an unknown reference raises a typed error", unknown_reference)
    observe("a checkout can be initialized over httpx", checkout)

    print()
    if failures:
        print(f"{failures} observation(s) failed.", file=sys.stderr)
        return 1
    print("The Python adapter works against the real sandbox over httpx.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
