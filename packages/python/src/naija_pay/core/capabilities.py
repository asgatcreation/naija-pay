"""Capability declarations.

Each adapter declares exactly what it can do. Two things follow, and both are the point
of this module:

1. An unsupported operation fails **locally, before any network call**, with a clear
   message -- rather than degrading into something that looks like it worked.
2. The capability matrix in the docs is generated from these declarations, so it cannot
   drift from the code.

Some provider features exist in the documentation but need the provider's commercial
approval before they work in live mode. Monnify's own OpenAPI spec says this about its
Transfer API and its Sub Accounts. Those are declared ``requires_approval``, so nobody
designs around a feature they cannot switch on.

Mirrors ``packages/ts/src/core/capabilities.ts``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Mapping, Sequence

from naija_pay.core.errors import UnsupportedOperationError

#: Every operation in the normalised API. Names match the method paths in DESIGN.md.
Operation = Literal[
    # Collections
    "checkout.create",
    "transactions.verify",
    "transactions.list",
    "refunds.create",
    "refunds.status",
    # Virtual accounts
    "virtualAccounts.createStatic",
    "virtualAccounts.createDynamic",
    "virtualAccounts.get",
    "virtualAccounts.list",
    "virtualAccounts.updateKyc",
    "virtualAccounts.deactivate",
    "virtualAccounts.listInflows",
    # Split-payment sub-accounts
    "splitAccounts.create",
    "splitAccounts.update",
    "splitAccounts.list",
    "splitAccounts.deactivate",
    "splits.create",
    "splits.update",
    "splits.list",
    "splits.settlements",
    # Wallet / banking sub-accounts
    "wallets.onboardCustomer",
    "wallets.open",
    "wallets.balance",
    "wallets.statement",
    "wallets.transfer",
    "wallets.freeze",
    "wallets.unfreeze",
    "wallets.close",
    # Payouts
    "payouts.create",
    "payouts.createBulk",
    "payouts.status",
    "banks.list",
    "banks.resolveAccount",
    "balance.get",
    # Recurring and mandates
    "plans.create",
    "subscriptions.create",
    "charges.chargeAuthorization",
    "mandates.create",
    "mandates.status",
    "mandates.debit",
    "mandates.cancel",
    # Identity
    "identity.verifyBvn",
    "identity.verifyNin",
    # Webhooks
    "webhooks.verify",
]

#: Payment channels a provider can present at checkout.
Channel = Literal[
    "card",
    "bank_transfer",
    "ussd",
    "bank_account",
    "qr",
    "wallet",
    "mobile_money",
    "apple_pay",
    "google_pay",
]

SignatureStrength = Literal["full-body", "partial-body", "shared-secret", "unverified"]


@dataclass(frozen=True, slots=True)
class OperationSupport:
    #: Documented but gated behind the provider's commercial approval before it works in
    #: live mode. The operation still runs; the flag exists so the capability matrix and
    #: the docs can say so.
    requires_approval: bool = False
    #: Implemented from documentation but not yet exercised against the provider's
    #: sandbox. Surfaced in the docs so nobody mistakes "written" for "verified".
    not_yet_sandbox_verified: bool = False
    #: Identity fields this provider requires for this operation, e.g. ("bvn",).
    required_kyc: tuple[str, ...] = ()
    #: Anything a developer would be surprised by. Appears in the generated matrix.
    notes: str | None = None


@dataclass(frozen=True, slots=True)
class WebhookSignature:
    """How this provider's webhook signature actually works, as documented.

    See the webhook table in PROVIDERS.md -- three Tier 1 providers cannot offer
    full-body integrity, and this is how an application finds that out in code.
    """

    strength: SignatureStrength
    header: str | None = None
    algorithm: str | None = None
    notes: str | None = None


@dataclass(frozen=True, slots=True)
class ProviderCapabilities:
    provider: str
    #: Operations this provider supports. Absent means unsupported.
    operations: Mapping[str, OperationSupport] = field(default_factory=dict)
    channels: tuple[str, ...] = ()
    currencies: tuple[str, ...] = ()
    webhook_signature: WebhookSignature | None = None


def supports(caps: ProviderCapabilities, operation: str) -> bool:
    """Does this provider declare support for the operation at all?"""
    return operation in caps.operations


def support_for(caps: ProviderCapabilities, operation: str) -> OperationSupport | None:
    """The declaration for an operation, or None when unsupported."""
    return caps.operations.get(operation)


def assert_supported(caps: ProviderCapabilities, operation: str) -> None:
    """Raise unless this provider supports the operation.

    Every adapter method begins with this, so an unsupported call costs nothing and
    explains itself. On Paystack, for example, ``wallets.open`` fails here: Paystack has
    no wallet product, and pretending otherwise would be the worst thing this SDK could
    do.
    """
    if not supports(caps, operation):
        raise UnsupportedOperationError(
            provider=caps.provider,
            operation=operation,
            reason=(
                "See the capability matrix in PROVIDERS.md for which providers support "
                f"{operation}."
            ),
        )


def operations_requiring_approval(caps: ProviderCapabilities) -> list[str]:
    """Operations needing provider approval before they work live."""
    return sorted(op for op, s in caps.operations.items() if s.requires_approval)


def operations_not_sandbox_verified(caps: ProviderCapabilities) -> list[str]:
    """Operations implemented from docs but not yet sandbox-verified."""
    return sorted(op for op, s in caps.operations.items() if s.not_yet_sandbox_verified)


def required_kyc_for(caps: ProviderCapabilities, operation: str) -> tuple[str, ...]:
    """Identity fields required for an operation, so KycRequiredError can be raised
    locally before a request is sent.

    Fincra, for instance, requires a BVN for NGN permanent virtual accounts, and failing
    fast beats an opaque provider rejection.
    """
    support = caps.operations.get(operation)
    return support.required_kyc if support else ()


__all__: Sequence[str] = [
    "Channel",
    "Operation",
    "OperationSupport",
    "ProviderCapabilities",
    "SignatureStrength",
    "WebhookSignature",
    "assert_supported",
    "operations_not_sandbox_verified",
    "operations_requiring_approval",
    "required_kyc_for",
    "support_for",
    "supports",
]
