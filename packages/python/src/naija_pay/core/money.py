"""Money.

An amount is an integer in the currency's minor unit -- kobo for naira -- and never a
float. This is not stylistic fussiness. Korapay's own PHP webhook sample has to set
``serialize_precision = -1`` so that re-encoding an amount does not change it, which is
what a float round-trip inside a signature check looks like in production.

Splits use integer arithmetic throughout, and the rounding remainder goes somewhere
explicit rather than evaporating.

Mirrors ``packages/ts/src/core/money.ts``; the parity tests assert the two agree.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal

#: Currencies the Tier 1 providers document support for.
Currency = Literal["NGN", "GHS", "KES", "ZAR", "USD", "XOF"]

#: How many minor units make one major unit.
#:
#: XOF is the odd one out: it has no subunit, but Paystack documents that amounts are
#: still multiplied by 100 and that any fractional part is dropped during processing. We
#: therefore treat it as exponent 2 like the others, and ``from_major`` refuses a
#: fractional XOF amount rather than letting the provider silently discard it.
_MINOR_UNIT_EXPONENT: dict[str, int] = {
    "NGN": 2,
    "GHS": 2,
    "KES": 2,
    "ZAR": 2,
    "USD": 2,
    "XOF": 2,
}

#: XOF has no real subunit, so a fractional major amount is meaningless.
_CURRENCIES_WITHOUT_SUBUNIT: frozenset[str] = frozenset({"XOF"})

#: Basis points: 10000 bps is 100%. Integers only, so no float percentages.
BASIS_POINTS_TOTAL = 10_000

#: JavaScript's Number.MAX_SAFE_INTEGER. Python has arbitrary-precision integers, but
#: an amount that cannot survive a round trip through the TypeScript package is a
#: parity bug waiting to happen, so both languages enforce the same ceiling.
_MAX_SAFE_INTEGER = 9_007_199_254_740_991


class MoneyError(ValueError):
    """An amount, currency or share that must never reach a provider."""


@dataclass(frozen=True, slots=True)
class Money:
    """An integer count of minor units, with its currency."""

    amount: int
    currency: str


def _assert_known_currency(currency: str) -> None:
    if currency not in _MINOR_UNIT_EXPONENT:
        supported = ", ".join(_MINOR_UNIT_EXPONENT)
        raise MoneyError(f'unknown currency "{currency}"; supported: {supported}')


def _assert_valid_amount(amount: int, currency: str) -> None:
    # bool is an int subclass in Python, and True would silently become 1.
    if isinstance(amount, bool) or not isinstance(amount, int):
        if isinstance(amount, float):
            raise MoneyError(
                f"amount must be an integer number of minor units, received {amount}. "
                f"For {currency}, 1.50 is 150, not 1.5"
            )
        raise MoneyError(f"amount must be an integer, received {amount!r}")
    if amount < 0:
        raise MoneyError(f"amount must not be negative, received {amount}")
    if amount > _MAX_SAFE_INTEGER:
        raise MoneyError(f"amount {amount} exceeds the safe integer range")


def money(amount: int, currency: str) -> Money:
    """Construct an amount from a count of minor units (kobo, cents, pesewas)."""
    _assert_known_currency(currency)
    _assert_valid_amount(amount, currency)
    return Money(amount=amount, currency=currency)


def naira(major_units: float) -> Money:
    """Naira to kobo. ``naira(150)`` is 15000 kobo."""
    return from_major(major_units, "NGN")


def from_major(major_units: float, currency: str) -> Money:
    """Convert a major-unit amount (150.75 naira) into Money (15075 kobo).

    Takes a float only at this boundary, and refuses anything with more decimal places
    than the currency actually has, rather than rounding it away behind the caller's
    back.
    """
    _assert_known_currency(currency)
    if isinstance(major_units, bool) or not isinstance(major_units, (int, float)):
        raise MoneyError(f"major amount must be a finite number, received {major_units!r}")
    if isinstance(major_units, float) and (math.isnan(major_units) or math.isinf(major_units)):
        raise MoneyError(f"major amount must be a finite number, received {major_units!r}")

    if currency in _CURRENCIES_WITHOUT_SUBUNIT and float(major_units) != int(major_units):
        raise MoneyError(
            f"{currency} has no subunit, so {major_units} cannot be represented. "
            "Providers drop the fractional part during processing, so naija-pay "
            "refuses it here instead"
        )

    exponent = _MINOR_UNIT_EXPONENT[currency]
    factor = 10**exponent
    scaled = round(major_units * factor)

    if abs(scaled / factor - major_units) > 1e-9 * max(1.0, abs(float(major_units))):
        raise MoneyError(
            f"{major_units} {currency} has more precision than {currency} supports "
            f"({exponent} decimal places)"
        )
    return money(int(scaled), currency)


def minor_unit_exponent(currency: str) -> int:
    """The minor-unit exponent for a currency, e.g. 2 for NGN."""
    _assert_known_currency(currency)
    return _MINOR_UNIT_EXPONENT[currency]


def _assert_same_currency(a: Money, b: Money) -> None:
    if a.currency != b.currency:
        raise MoneyError(f"cannot combine {a.currency} and {b.currency}")


def add(a: Money, b: Money) -> Money:
    _assert_same_currency(a, b)
    return money(a.amount + b.amount, a.currency)


def subtract(a: Money, b: Money) -> Money:
    _assert_same_currency(a, b)
    if b.amount > a.amount:
        raise MoneyError(f"subtracting {b.amount} from {a.amount} would produce a negative amount")
    return money(a.amount - b.amount, a.currency)


def is_zero(m: Money) -> bool:
    return m.amount == 0


def compare(a: Money, b: Money) -> int:
    _assert_same_currency(a, b)
    if a.amount < b.amount:
        return -1
    return 1 if a.amount > b.amount else 0


def format_money(m: Money) -> str:
    """Formats for humans: ``money(15075, "NGN")`` becomes ``"NGN 150.75"``."""
    exponent = _MINOR_UNIT_EXPONENT[m.currency]
    if exponent == 0:
        return f"{m.currency} {m.amount}"
    factor = 10**exponent
    major, minor = divmod(m.amount, factor)
    return f"{m.currency} {major}.{str(minor).zfill(exponent)}"


@dataclass(frozen=True, slots=True)
class Share:
    """Portion in basis points for a percentage split, or minor units for a flat one."""

    account: str
    share: int


@dataclass(frozen=True, slots=True)
class SplitPart:
    account: str
    amount: Money


@dataclass(frozen=True, slots=True)
class SplitResult:
    parts: tuple[SplitPart, ...]
    #: What is left for the main account after every share: the residue plus the
    #: rounding remainder. Integer division cannot divide every amount evenly, and the
    #: leftover kobo has to belong to someone -- it is never dropped.
    remainder: Money


def split_by_basis_points(total: Money, shares: Sequence[Share]) -> SplitResult:
    """Split an amount by basis-point shares.

    Each share is floored, and every leftover minor unit lands in ``remainder``, so the
    parts plus the remainder always sum exactly to the input.
    """
    total_bps = 0
    for s in shares:
        if isinstance(s.share, bool) or not isinstance(s.share, int) or s.share < 0:
            raise MoneyError(
                f'share for "{s.account}" must be a non-negative integer number of '
                f"basis points, received {s.share}"
            )
        total_bps += s.share
    if total_bps > BASIS_POINTS_TOTAL:
        raise MoneyError(
            f"shares total {total_bps} basis points, which is more than 100% ({BASIS_POINTS_TOTAL})"
        )

    parts: list[SplitPart] = []
    allocated = 0
    for s in shares:
        # Floor division on integers: no float ever enters the calculation.
        amount = (total.amount * s.share) // BASIS_POINTS_TOTAL
        allocated += amount
        parts.append(SplitPart(account=s.account, amount=money(amount, total.currency)))

    return SplitResult(
        parts=tuple(parts),
        remainder=money(total.amount - allocated, total.currency),
    )


def split_by_flat_amounts(total: Money, shares: Sequence[Share]) -> SplitResult:
    """Split by flat amounts, each already in minor units.

    Fails if the flat amounts exceed the total, because a split that pays out more than
    came in is always a bug and must never reach a provider.
    """
    parts: list[SplitPart] = []
    allocated = 0
    for s in shares:
        part = money(s.share, total.currency)
        allocated += part.amount
        parts.append(SplitPart(account=s.account, amount=part))
    if allocated > total.amount:
        raise MoneyError(
            f"flat shares total {allocated} {total.currency} minor units, "
            f"which is more than the {total.amount} being split"
        )
    return SplitResult(
        parts=tuple(parts),
        remainder=money(total.amount - allocated, total.currency),
    )
