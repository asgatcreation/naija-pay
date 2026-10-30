"""Webhook signature schemes.

This module is where the research in PROVIDERS.md becomes code. Eight schemes across
seven providers, three hash algorithms, two encodings, two kinds of key -- and three
providers whose published documentation does not let you verify correctly at all.

Three principles:

1. **Verify over the raw bytes.** Signatures are computed over exact bytes, so the body
   must never be parsed, re-serialised or redacted first. Every function here takes
   ``bytes``, not a string or a dict, to make that hard to get wrong.
2. **Be honest about strength.** A scheme that proves nothing about the payload is
   reported as ``shared-secret``, not dressed up as a signature. An application can then
   refuse to act on a weak one.
3. **Constant-time comparison always**, via ``hmac.compare_digest``.

Verified from each provider's current documentation on 2026-10-25; see PROVIDERS.md for
the per-provider detail and the dates.

Mirrors ``packages/ts/src/core/signatures.ts``.
"""

from __future__ import annotations

import base64
import hashlib
import hmac as _hmac
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Literal

#: How strongly a received webhook was actually verified.
#:
#: - ``full-body``     HMAC over the whole raw body (Paystack, Flutterwave v4, Fincra)
#: - ``partial-body``  HMAC over only part of the payload (Korapay signs ``data`` only,
#:                     leaving the event name unauthenticated)
#: - ``shared-secret`` a secret was presented but nothing binds it to the payload, so
#:                     there is no integrity and no replay protection (Flutterwave v3)
#: - ``unverified``    the provider's scheme is undocumented, or verification was
#:                     explicitly skipped (Squad and Monnify, as of 2026-10-25)
SignatureStrength = Literal["full-body", "partial-body", "shared-secret", "unverified"]

#: What a provider's documented scheme actually does. See the TypeScript twin for the
#: per-kind notes; they are identical by design.
SignatureKind = Literal[
    "hmac-hex",
    "hmac-base64",
    "hmac-base64-of-hex",
    "shared-secret",
    "undocumented",
]

HashAlgorithm = Literal["SHA-1", "SHA-256", "SHA-512"]

_HASHES: dict[str, Any] = {
    "SHA-1": hashlib.sha1,
    "SHA-256": hashlib.sha256,
    "SHA-512": hashlib.sha512,
}


@dataclass(frozen=True, slots=True)
class SignatureScheme:
    kind: SignatureKind
    #: Header carrying the signature, lowercase.
    header: str
    #: How strong this is, honestly. ``strength_of`` derives the same value; it is
    #: stated explicitly so the claim is reviewable, and a test asserts they agree.
    strength: SignatureStrength
    algorithm: HashAlgorithm | None = None
    #: ``None`` means the whole raw body. A tuple of keys means only that sub-object is
    #: signed -- Korapay signs ``data`` alone, leaving the event name unauthenticated.
    json_path: tuple[str, ...] | None = None


class SignatureSchemeError(ValueError):
    """A scheme could not be applied to this body at all.

    As distinct from a signature that simply did not match. Named identically in both
    languages so the parity tests can compare rejections.
    """


def constant_time_equal(a: str, b: str) -> bool:
    """Constant-time comparison. Never use ``==`` on a signature."""
    return _hmac.compare_digest(a.encode("utf-8"), b.encode("utf-8"))


def _payload_to_sign(scheme: SignatureScheme, body: bytes) -> bytes:
    """The bytes a scheme actually signs.

    For the whole body this is the untouched bytes, which is always what we want. For a
    ``json_path`` scheme the provider signs a sub-object, so there is no choice but to
    parse and re-serialise -- a canonicalisation hazard that is documented rather than
    hidden. Korapay's own PHP sample has to disable float precision mangling for exactly
    this reason, which is also why naija-pay never represents money as a float.
    """
    if scheme.json_path is None:
        return body

    path = ".".join(scheme.json_path)

    try:
        cursor: Any = json.loads(body.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        # The runtimes word their JSON errors differently, so we raise our own: the
        # message is part of the cross-language contract the parity tests check.
        raise SignatureSchemeError(
            f'the webhook body is not valid JSON, so the signature over its "{path}" '
            "cannot be checked"
        ) from exc

    missing = object()
    for key in scheme.json_path:
        if not isinstance(cursor, dict):
            raise SignatureSchemeError(
                f'the webhook body has no "{path}" to sign, so its signature cannot be checked'
            )
        cursor = cursor.get(key, missing)

    # Without this, a body missing the signed sub-object would serialise to the literal
    # string "null" and then verify against itself -- accepting an unsigned event.
    if cursor is missing:
        raise SignatureSchemeError(
            f'the webhook body has no "{path}" to sign, so its signature cannot be checked'
        )

    # separators matter: this must match what the provider's own JSON encoder produced.
    return json.dumps(cursor, separators=(",", ":")).encode("utf-8")


def compute_signature(scheme: SignatureScheme, body: bytes, secret: str) -> str:
    """Compute a signature for a body under a scheme. Used to verify, and by the mock."""
    if scheme.kind == "shared-secret":
        return secret
    if scheme.kind == "undocumented":
        raise SignatureSchemeError(
            f'the signature scheme for header "{scheme.header}" is undocumented, so it '
            "cannot be computed. See PROVIDERS.md: this applies to Squad and Monnify, "
            "whose schemes must be established against their sandboxes first."
        )

    algorithm = scheme.algorithm or "SHA-512"
    digest_mod = _HASHES[algorithm]
    mac = _hmac.new(secret.encode("utf-8"), _payload_to_sign(scheme, body), digest_mod)

    if scheme.kind == "hmac-hex":
        return mac.hexdigest()
    if scheme.kind == "hmac-base64":
        return base64.b64encode(mac.digest()).decode("ascii")
    # Anchor's samples base64-encode the hex digest STRING, not the raw digest.
    return base64.b64encode(mac.hexdigest().encode("utf-8")).decode("ascii")


@dataclass(frozen=True, slots=True)
class VerificationResult:
    verified: bool
    strength: SignatureStrength
    #: Why it failed, for the error message. Never includes the secret.
    reason: str | None = None


def verify_signature(
    *,
    scheme: SignatureScheme,
    body: bytes,
    headers: Mapping[str, str],
    secret: str,
) -> VerificationResult:
    """Verify a webhook signature.

    Returns a result rather than raising, because the caller decides what an unverified
    event means -- and for Squad and Monnify today, "cannot be verified" is a legitimate
    outcome that must not be mistaken for "verified".
    """
    if scheme.kind == "undocumented":
        return VerificationResult(
            verified=False,
            strength="unverified",
            reason=(
                f'the signature scheme for "{scheme.header}" is undocumented by the '
                "provider, so this event cannot be verified. Accept it only with the "
                "explicit allow-unverified option, and re-verify with the API before "
                "giving value."
            ),
        )

    lowered = {k.lower(): v for k, v in headers.items()}
    provided = lowered.get(scheme.header.lower())
    if not provided:
        return VerificationResult(
            verified=False,
            strength="unverified",
            reason=f'the "{scheme.header}" header is missing',
        )

    try:
        expected = compute_signature(scheme, body, secret)
    except (SignatureSchemeError, ValueError) as exc:
        return VerificationResult(verified=False, strength="unverified", reason=str(exc))

    if constant_time_equal(provided, expected):
        return VerificationResult(verified=True, strength=scheme.strength)

    return VerificationResult(
        verified=False,
        strength=scheme.strength,
        reason=(
            "the signature did not match. The usual cause is that the raw request body "
            "was parsed or re-serialised before verification: signatures cover exact "
            "bytes."
        ),
    )


def strength_of(scheme: SignatureScheme) -> SignatureStrength:
    """The honest strength for a scheme, used to cross-check each declaration."""
    if scheme.kind == "undocumented":
        return "unverified"
    if scheme.kind == "shared-secret":
        return "shared-secret"
    return "full-body" if scheme.json_path is None else "partial-body"


#: The Tier 1 schemes, each read from that provider's current documentation on
#: 2026-10-25. Adapters import these rather than restating them.
SCHEMES: dict[str, SignatureScheme] = {
    "paystack": SignatureScheme(
        kind="hmac-hex",
        header="x-paystack-signature",
        algorithm="SHA-512",
        strength="full-body",
    ),
    # Flutterwave v4: HMAC-SHA256 over the raw body, base64.
    "flutterwaveV4": SignatureScheme(
        kind="hmac-base64",
        header="flutterwave-signature",
        algorithm="SHA-256",
        strength="full-body",
    ),
    # Flutterwave v3: the documented method is to compare the `verif-hash` header
    # against your own secret hash. It proves only that the sender knows a shared
    # secret; nothing binds it to the payload, so there is no integrity and no replay
    # protection.
    "flutterwaveV3": SignatureScheme(
        kind="shared-secret",
        header="verif-hash",
        strength="shared-secret",
    ),
    # Fincra: HMAC-SHA512 hex, keyed with the SEPARATE webhook secret key rather than
    # the API secret.
    "fincra": SignatureScheme(
        kind="hmac-hex",
        header="signature",
        algorithm="SHA-512",
        strength="full-body",
    ),
    # Korapay: HMAC-SHA256 hex over the `data` object ONLY. The `event` field sits
    # outside the signed region and is therefore unauthenticated.
    "korapay": SignatureScheme(
        kind="hmac-hex",
        header="x-korapay-signature",
        algorithm="SHA-256",
        json_path=("data",),
        strength="partial-body",
    ),
    # Anchor: HMAC-SHA1, base64 of the hex digest, per its own code samples.
    "anchor": SignatureScheme(
        kind="hmac-base64-of-hex",
        header="x-anchor-signature",
        algorithm="SHA-1",
        strength="full-body",
    ),
    # Squad: header documented, algorithm and key are NOT. Must not be guessed.
    "squad": SignatureScheme(
        kind="undocumented",
        header="x-squad-encrypted-body",
        strength="unverified",
    ),
    # Monnify: its OpenAPI spec documents no webhooks at all.
    "monnify": SignatureScheme(
        kind="undocumented",
        header="monnify-signature",
        strength="unverified",
    ),
}


__all__: Sequence[str] = [
    "SCHEMES",
    "HashAlgorithm",
    "SignatureKind",
    "SignatureScheme",
    "SignatureSchemeError",
    "SignatureStrength",
    "VerificationResult",
    "compute_signature",
    "constant_time_equal",
    "strength_of",
    "verify_signature",
]
