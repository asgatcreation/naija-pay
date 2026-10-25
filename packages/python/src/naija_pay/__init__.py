"""naija-pay — one typed interface to every Nigerian payment and banking-as-a-service provider.

This is the scaffold entry point (milestone 2). The core — money types, typed errors,
the HTTP layer, redaction and the webhook parser — lands in milestone 3. The API
contract being built to is in DESIGN.md at the repository root.
"""

from typing import Literal

#: The package version. Kept identical to the TypeScript package; CI enforces it.
__version__ = "0.0.0"

#: Environments a client can be configured for. A provider's key prefix is checked
#: against this, because several providers use the same host for test and live.
Environment = Literal["test", "live"]

#: How strongly a received webhook was actually verified.
#:
#: Providers differ enormously here — see the webhook table in PROVIDERS.md. Rather
#: than pretending they are equivalent, every parsed event reports which of these it
#: earned, so an application can refuse to act on a weak one.
#:
#: - ``full-body``     HMAC over the whole raw body (Paystack, Flutterwave v4)
#: - ``partial-body``  HMAC over only part of the payload (Korapay signs ``data``
#:                     only, leaving the event name unauthenticated)
#: - ``shared-secret`` a secret was presented but nothing binds it to the payload,
#:                     so there is no integrity and no replay protection
#:                     (Flutterwave v3)
#: - ``unverified``    the provider's scheme is undocumented, or verification was
#:                     explicitly skipped (Squad and Monnify, as of 2026-10-25)
SignatureStrength = Literal["full-body", "partial-body", "shared-secret", "unverified"]

__all__ = ["Environment", "SignatureStrength", "__version__"]
