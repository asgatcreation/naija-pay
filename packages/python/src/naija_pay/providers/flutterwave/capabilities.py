"""What the Flutterwave adapter can do.

Read from Flutterwave's current documentation on 2026-11-02: the v3 reference at
https://developer.flutterwave.com/reference/ and the v4 reference at
https://developer.flutterwave.com/v4.0.0/reference/. Every page carries an ``updatedAt``
stamp, recorded per fixture in ``fixtures/providers/flutterwave/``.

Why this adapter talks v3
-------------------------
Flutterwave is mid-migration and the two versions are not two spellings of one API. The
research is in PROVIDERS.md; the short version is that v4 cannot carry this adapter's
surface:

- **No hosted checkout.** v4 collections run ``POST /customers``, then
  ``POST /payment-methods``, then ``POST /charges``. There is no hosted page and no
  payment link, so taking a card payment on v4 means handling the card ourselves.
  naija-pay never touches raw card numbers, so v4 collections are out of scope by
  policy, not by omission. v3's ``POST /payments`` returns a hosted link.
- **No split payments and no payout subaccounts.** Neither concept exists anywhere in
  the v4 reference. Splits and customer wallets are two of the four things this SDK
  exists to normalise.
- **Two credentials and two token lifecycles.** v3 authenticates with a static
  ``FLWSECK`` secret key; v4 uses OAuth 2.0 client credentials against a Keycloak host,
  with a ten-minute access token.

What v4 does bring, and what this adapter takes from it, is the webhook scheme: v4 signs
the raw body with HMAC-SHA256, so ``verify_webhook`` accepts a v4 signature as
``full-body`` and a v3 one as ``shared-secret``.

Mirrors ``packages/ts/src/providers/flutterwave/capabilities.ts``.
"""

from __future__ import annotations

from naija_pay.core.capabilities import (
    OperationSupport,
    ProviderCapabilities,
    WebhookSignature,
)

FLUTTERWAVE_PROVIDER_NAME = "flutterwave"

#: One host for test and live, exactly as with Paystack: only the key says which you are
#: in. v4's sandbox is a different host, which is safer, but v3 does not work that way.
FLUTTERWAVE_BASE_URL = "https://api.flutterwave.com/v3"

#: v4's OAuth token endpoint, recorded for the webhook docs and the v4 follow-up.
FLUTTERWAVE_V4_TOKEN_URL = (
    "https://idp.flutterwave.com/realms/flutterwave/protocol/openid-connect/token"
)

#: Flutterwave's ``payment_options`` names, which are not ours.
#:
#: Theirs are a comma-separated string, not an array: ``"card,banktransfer,ussd"``. Note
#: ``banktransfer`` has no separator, and ``account`` means "pay with bank account",
#: which we call ``bank_account``.
CHANNEL_TO_FLUTTERWAVE: dict[str, str] = {
    "card": "card",
    "bank_account": "account",
    "bank_transfer": "banktransfer",
    "ussd": "ussd",
    "qr": "qr",
    "mobile_money": "mobilemoneyghana",
    "apple_pay": "applepay",
}

CHANNEL_FROM_FLUTTERWAVE: dict[str, str] = {
    "card": "card",
    "account": "bank_account",
    "banktransfer": "bank_transfer",
    "ussd": "ussd",
    "qr": "qr",
    "mobilemoneyghana": "mobile_money",
    "applepay": "apple_pay",
}

_SUPPORTED: dict[str, OperationSupport] = {
    "checkout.create": OperationSupport(
        notes=(
            "v3 Standard: POST /payments returns a hosted link. Amounts go on the wire "
            "as decimals in major units, converted from minor units by core/money."
        )
    ),
    "transactions.verify": OperationSupport(
        notes=(
            "Verify by Flutterwave's numeric transaction id, or by your own reference "
            "with verify_transaction_by_reference. Returns amount, charged amount and "
            "settled amount separately -- they differ whenever the customer bears the fee."
        )
    ),
    "transactions.list": OperationSupport(),
    "refunds.create": OperationSupport(
        notes="Amount is optional and defaults to the full transaction amount."
    ),
    "refunds.status": OperationSupport(
        notes="Served from the transaction's refund list; Flutterwave has no refund-by-id route."
    ),
    "virtualAccounts.createStatic": OperationSupport(
        required_kyc=("bvn",),
        not_yet_sandbox_verified=True,
        notes=(
            "is_permanent true. Flutterwave accepts a NIN in place of a BVN for static "
            "accounts. The response is an acknowledgement -- response_code 02 means "
            "'Transaction in progress', so the account may not be usable yet."
        ),
    ),
    "virtualAccounts.createDynamic": OperationSupport(
        not_yet_sandbox_verified=True,
        notes=(
            "is_permanent false, with an amount and an expiry in seconds. Unlike "
            "Paystack, Flutterwave does offer a per-transaction expiring account."
        ),
    ),
    "virtualAccounts.get": OperationSupport(not_yet_sandbox_verified=True),
    "virtualAccounts.updateKyc": OperationSupport(
        not_yet_sandbox_verified=True,
        notes="PUT /virtual-account-numbers/update-bvn. BVN only; NIN cannot be updated this way.",
    ),
    "virtualAccounts.deactivate": OperationSupport(not_yet_sandbox_verified=True),
    "splitAccounts.create": OperationSupport(
        notes=(
            "Collection subaccounts. split_value is a decimal fraction in "
            "Flutterwave's API (0.09 is 9%); we take basis points and convert."
        )
    ),
    "splitAccounts.list": OperationSupport(),
    "splitAccounts.update": OperationSupport(),
    "splitAccounts.deactivate": OperationSupport(),
    "splits.create": OperationSupport(
        notes=(
            "Flutterwave has no standalone split object: the split is declared on the "
            "checkout by listing subaccounts. create_split therefore returns a reusable "
            "declaration to pass to create_checkout, and makes no network call."
        )
    ),
    # The whole reason Flutterwave earns the wallet tier that Paystack cannot.
    "wallets.open": OperationSupport(
        not_yet_sandbox_verified=True,
        notes=(
            "Payout subaccounts are real NGN wallets with their own NUBAN. Documented "
            "as NGN-only, so opening one in another currency fails locally."
        ),
    ),
    "wallets.balance": OperationSupport(not_yet_sandbox_verified=True),
    "wallets.transfer": OperationSupport(
        not_yet_sandbox_verified=True,
        notes=(
            "POST /transfers with debit_subaccount set to the wallet's "
            "account_reference. Wallet-to-wallet uses account_bank 'flutterwave' with "
            "the destination's barter_id."
        ),
    ),
    "wallets.statement": OperationSupport(
        not_yet_sandbox_verified=True,
        notes="Transactions on the subaccount, paginated.",
    ),
    "payouts.create": OperationSupport(
        notes=(
            "POST /transfers returns data.status 'NEW' -- the transfer is QUEUED, not "
            "completed, even though the envelope says 'success'. Reported as pending. "
            "requires_approval 1 means a human must approve it on the dashboard."
        )
    ),
    "payouts.status": OperationSupport(),
    "banks.list": OperationSupport(),
    "banks.resolveAccount": OperationSupport(
        notes="The response does not echo the bank code, so the adapter carries it through."
    ),
    "balance.get": OperationSupport(),
    "webhooks.verify": OperationSupport(
        notes=(
            "Accepts both schemes. A v4 flutterwave-signature header verifies as "
            "full-body; a v3 verif-hash header is only a shared secret and is reported "
            "as such."
        )
    ),
}

#: Operations Flutterwave supports that this adapter has not implemented yet.
#:
#: Kept as data rather than prose so the generated capability matrix can show them as
#: planned instead of silently missing.
NOT_YET_IMPLEMENTED: dict[str, str] = {
    "virtualAccounts.list": (
        "Flutterwave has no route that lists every virtual account; only the "
        "bulk-batch route lists accounts created in one batch. Revisit in milestone 7."
    ),
    "virtualAccounts.listInflows": (
        "Served from the transaction list in milestone 7, as on Paystack."
    ),
    "splits.update": (
        "There is no split object to update: change the subaccount's default, or "
        "declare different shares on the next checkout."
    ),
    "splits.list": "Same reason as splits.update.",
    "splits.settlements": "Milestone 7.",
    "wallets.onboardCustomer": (
        "Flutterwave opens the wallet and runs its own KYC; there is no separate onboarding call."
    ),
    "wallets.freeze": "Not offered by Flutterwave's payout subaccount API.",
    "wallets.unfreeze": "Not offered by Flutterwave's payout subaccount API.",
    "wallets.close": "DELETE /payout-subaccounts/{id} exists; lands in milestone 7.",
    "payouts.createBulk": "POST /bulk-transfers. Milestone 7.",
    "plans.create": "Recurring billing lands in milestone 7.",
    "subscriptions.create": "Recurring billing lands in milestone 7.",
    "charges.chargeAuthorization": "Tokenised charges. Recurring billing lands in milestone 7.",
    "mandates.create": "Flutterwave Direct Debit (e-mandate) lands in milestone 7.",
    "mandates.status": "Flutterwave Direct Debit lands in milestone 7.",
    "mandates.debit": "Flutterwave Direct Debit lands in milestone 7.",
    "mandates.cancel": "Flutterwave Direct Debit lands in milestone 7.",
    "identity.verifyBvn": (
        "Flutterwave's BVN endpoint requires a consent flow the customer completes in a "
        "browser, so it needs its own design. Milestone 7."
    ),
    "identity.verifyNin": "Not offered as a standalone call by Flutterwave.",
}

flutterwave_capabilities = ProviderCapabilities(
    provider=FLUTTERWAVE_PROVIDER_NAME,
    operations=_SUPPORTED,
    channels=("card", "bank_account", "bank_transfer", "ussd", "qr", "mobile_money", "apple_pay"),
    currencies=("NGN", "GHS", "KES", "ZAR", "USD", "XOF"),
    # The weakest webhook story in Tier 1, and the reason signature strength exists.
    #
    # v3 sends `verif-hash` carrying the secret hash itself. It is the same on every
    # request and says nothing about the payload, so it proves only that the sender
    # knows the secret -- no integrity, no replay protection. We report that honestly as
    # `shared-secret` rather than calling it a signature.
    #
    # The declaration below describes v4 in `algorithm` because that is the strongest
    # thing the provider offers, while `strength` stays at the weaker of the two:
    # `verify_webhook` picks the scheme from the headers actually present and reports
    # the strength of the one it used.
    webhook_signature=WebhookSignature(
        strength="shared-secret",
        header="verif-hash (v3), flutterwave-signature (v4)",
        algorithm=(
            "v3: the verif-hash header carries the secret hash verbatim, so there is no "
            "signature at all. v4: HMAC-SHA256 over the raw body, base64, keyed with "
            "the secret hash set on the dashboard."
        ),
        notes=(
            "Flutterwave's v4 webhook page contradicts itself: its prose and its first "
            "sample compute an HMAC-SHA256 of the raw body and base64-encode it, while "
            "three later samples compare the header directly against the secret -- "
            "which is the v3 behaviour, evidently left in during the rewrite. We "
            "implement the HMAC, because it is what the prose and the dedicated "
            "verification sample describe and because a wrong guess here fails closed: "
            "a genuine webhook would be rejected, not a forged one accepted. v4 "
            "verification is marked not_yet_sandbox_verified until observed against a "
            "real delivery."
        ),
    ),
)

#: Flutterwave publishes no webhook IP allowlist.
#:
#: Paystack does, and the Paystack adapter offers ``is_known_webhook_ip`` as a second
#: check. Flutterwave's documentation names no source IPs, so this adapter offers no such
#: method rather than one that always answers False.
FLUTTERWAVE_WEBHOOK_IPS: tuple[str, ...] = ()

__all__ = [
    "CHANNEL_FROM_FLUTTERWAVE",
    "CHANNEL_TO_FLUTTERWAVE",
    "FLUTTERWAVE_BASE_URL",
    "FLUTTERWAVE_PROVIDER_NAME",
    "FLUTTERWAVE_V4_TOKEN_URL",
    "FLUTTERWAVE_WEBHOOK_IPS",
    "NOT_YET_IMPLEMENTED",
    "flutterwave_capabilities",
]
