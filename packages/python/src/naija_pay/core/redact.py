"""Redaction.

BVNs, NINs, account numbers and credentials must never reach a log line, an error
message, an exception's string form, or a crash reporter. Under the Nigeria Data
Protection Act 2023 these are personal data; a leaked key is worse still.

Redaction is on by default and applied at construction time of anything that could be
printed, rather than at the point of logging. A path that forgets to redact is then
impossible, instead of merely discouraged.

IMPORTANT: never redact a webhook body before verifying its signature. Signatures are
computed over exact bytes, so masking first guarantees a mismatch. Verify, then redact
for logging. The webhook parser enforces that order.

Mirrors ``packages/ts/src/core/redact.ts``; the parity tests assert the two agree.
"""

from __future__ import annotations

import re
from typing import Any

#: Replacement for a value that is masked in full.
FULL_MASK = "[redacted]"


def _mask_middle(value: str, keep_start: int = 3, keep_end: int = 3) -> str:
    """Keep the first and last few characters, mask the middle.

    This is the convention the providers themselves use -- Paystack returns
    ``"bvn": "123*****456"`` in its identification webhooks.
    """
    if len(value) <= keep_start + keep_end:
        return "*" * len(value)
    return value[:keep_start] + "*" * (len(value) - keep_start - keep_end) + value[-keep_end:]


#: Credential patterns. Each keeps a recognisable prefix so the masked output still
#: tells you *which* credential was involved -- a leaked ``sk_live_`` is a different
#: emergency from a leaked ``sk_test_``.
_CREDENTIAL_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"\b(?:sandbox_)?(?:sk|pk)_(?:test|live)_[A-Za-z0-9]{4,}"),
    re.compile(r"\b(?:sandbox_)?(?:sk|pk)_[A-Za-z0-9]{8,}"),
    re.compile(r"\bFLW(?:SECK|PUBK)(?:_TEST)?-[A-Za-z0-9-]{4,}"),
    re.compile(r"\bMK_(?:TEST|PROD)_[A-Za-z0-9]{4,}"),
    re.compile(r"\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}", re.IGNORECASE),
    re.compile(r"\beyJ[A-Za-z0-9._-]{16,}"),
)

_PREFIX = re.compile(
    r"^(sandbox_sk_|sandbox_pk_|sk_test_|sk_live_|pk_test_|pk_live_|sk_|pk_|"
    r"FLWSECK_TEST-|FLWSECK-|FLWPUBK_TEST-|FLWPUBK-|MK_TEST_|MK_PROD_|"
    r"Bearer\s+|Basic\s+|eyJ)",
    re.IGNORECASE,
)

#: An 11-digit run is a BVN or a NIN; a 10-digit run is a NUBAN account number.
#: Bounded by non-digits so a long amount in minor units is not mistaken for an
#: identifier.
_ELEVEN_DIGITS = re.compile(r"(?<!\d)\d{11}(?!\d)")
_TEN_DIGITS = re.compile(r"(?<!\d)\d{10}(?!\d)")

#: Card numbers: 13 to 19 digits, optionally grouped. Must never appear at all.
_CARD_NUMBER = re.compile(r"(?<!\d)(?:\d[ -]?){13,19}(?!\d)")

#: Field names whose values are masked in full, matched case-insensitively and ignoring
#: separators, so ``secret_key``, ``secretKey`` and ``SECRET-KEY`` are all caught.
_FULLY_MASKED_FIELDS: frozenset[str] = frozenset(
    {
        "secretkey",
        "apikey",
        "publickey",
        "encryptionkey",
        "webhooksecret",
        "secrethash",
        "secret",
        "secrettoken",
        "token",
        "accesstoken",
        "refreshtoken",
        "idtoken",
        "clientsecret",
        "password",
        "authorization",
        "auth",
        "signature",
        "pan",
        "cardnumber",
        "cvv",
        "cvc",
        "expiry",
        "expirymonth",
        "expiryyear",
        "pin",
    }
)

#: Field names whose values are partially masked, keeping them correlatable.
_PARTIALLY_MASKED_FIELDS: frozenset[str] = frozenset(
    {
        "bvn",
        "nin",
        "vnin",
        "accountnumber",
        "accountno",
        "nuban",
        "destinationaccountnumber",
        "sourceaccountnumber",
        "sendderaccountnumber",
        "senderaccountnumber",
        "counterpartyaccountnumber",
        "phone",
        "phonenumber",
        "mobile",
        "msisdn",
    }
)

_NON_ALNUM = re.compile(r"[^a-z0-9]", re.IGNORECASE)


def _normalise_field_name(name: str) -> str:
    return _NON_ALNUM.sub("", name).lower()


def redact(text: Any) -> Any:
    """Mask credentials and identifiers inside a free-text string.

    Order matters: credentials are masked before digit runs, so a key containing digits
    is not partially rewritten first.
    """
    if not isinstance(text, str) or text == "":
        return text

    out = text

    for pattern in _CREDENTIAL_PATTERNS:

        def _replace(match: re.Match[str]) -> str:
            prefix_match = _PREFIX.match(match.group(0))
            prefix = prefix_match.group(0) if prefix_match else ""
            return f"{prefix}{FULL_MASK}"

        out = pattern.sub(_replace, out)

    def _replace_card(match: re.Match[str]) -> str:
        digits = re.sub(r"[ -]", "", match.group(0))
        return FULL_MASK if len(digits) >= 13 else match.group(0)

    out = _CARD_NUMBER.sub(_replace_card, out)
    out = _ELEVEN_DIGITS.sub(lambda m: _mask_middle(m.group(0)), out)
    out = _TEN_DIGITS.sub(lambda m: _mask_middle(m.group(0)), out)

    return out


def mask_account_number(account_number: str) -> str:
    """Mask an account number for display, keeping the ends."""
    return _mask_middle(account_number)


def mask_identity_number(value: str) -> str:
    """Mask a BVN or NIN for display, keeping the ends."""
    return _mask_middle(value)


def redact_object(value: Any, _seen: set[int] | None = None) -> Any:
    """Deep-redact a structure for logging.

    Returns a new value; the input is never mutated, because callers hand us objects
    they still intend to use. Sensitive field names are masked by name, and every
    remaining string is still passed through the pattern redactor -- a BVN in a
    ``reason`` field is just as sensitive as one in a ``bvn`` field.
    """
    if isinstance(value, str):
        return redact(value)
    if value is None or isinstance(value, (int, float, bool)):
        return value

    seen = set() if _seen is None else _seen
    # Cycles appear in real payloads once objects carry back-references.
    if id(value) in seen:
        return "[circular]"

    if isinstance(value, dict):
        seen = seen | {id(value)}
        out: dict[Any, Any] = {}
        for key, raw in value.items():
            name = _normalise_field_name(key) if isinstance(key, str) else ""
            if name in _FULLY_MASKED_FIELDS:
                out[key] = FULL_MASK
            elif name in _PARTIALLY_MASKED_FIELDS:
                out[key] = _mask_middle(raw) if isinstance(raw, str) else FULL_MASK
            else:
                out[key] = redact_object(raw, seen)
        return out

    if isinstance(value, (list, tuple)):
        seen = seen | {id(value)}
        items = [redact_object(v, seen) for v in value]
        return type(value)(items) if isinstance(value, tuple) else items

    return redact(str(value))


def looks_like_live_key(value: Any) -> bool:
    """Detect whether a string looks like a live (production) credential.

    Used for the loud warning when a live key turns up outside production. Paystack in
    particular serves test and live from the same host, so the key is the only signal
    that real money is about to move.
    """
    if not isinstance(value, str):
        return False
    return bool(
        re.search(r"\b(?:sk|pk)_live_", value)
        or (re.search(r"\bFLWSECK-", value) and not re.search(r"_TEST-", value))
        or re.search(r"\bMK_PROD_", value)
    )


def looks_like_test_key(value: Any) -> bool:
    """Detect whether a string looks like a test/sandbox credential."""
    if not isinstance(value, str):
        return False
    return bool(
        re.search(r"\b(?:sk|pk)_test_", value)
        or re.search(r"\bsandbox_(?:sk|pk)_", value)
        or re.search(r"\bFLW(?:SECK|PUBK)_TEST-", value)
        or re.search(r"\bMK_TEST_", value)
    )
