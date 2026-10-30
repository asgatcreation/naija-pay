"""The Paystack adapter.

Verified against https://paystack.com/docs/api/ on 2026-10-25 and 2026-10-30. Not yet
sandbox-verified; see PROVIDERS.md for the status table.

Three Paystack-specific traps this adapter absorbs, each from the docs:

1. **One host for test and live.** ``api.paystack.co`` serves both, and only the key says
   which you are in. A live key in staging moves real money with no URL change to catch
   it, so the key is checked against the declared environment at construction.
2. **Transfer references are strictly formatted.** Minimum 16 characters, and only
   lowercase letters, digits, dash and underscore. We validate locally and explain,
   rather than letting a payout fail at the provider.
3. **Transfers may require an OTP.** If OTP is enabled on the integration, a transfer
   comes back with status ``otp`` and cannot complete until a human enters a code sent to
   the business phone. That is reported as ``pending`` with ``awaiting_otp`` set, never as
   success.

Mirrors ``packages/ts/src/providers/paystack/index.ts``.
"""

from __future__ import annotations

import json
import os
import re
import sys
from collections.abc import Callable, Mapping, Sequence
from typing import Any

from naija_pay.core.capabilities import assert_supported
from naija_pay.core.errors import (
    ConfigurationError,
    DuplicateReferenceError,
    InsufficientFundsError,
    KycRequiredError,
    NaijaPayError,
    NotFoundError,
    ValidationError,
    error_class_for_status,
)
from naija_pay.core.http import (
    HttpClient,
    HttpClientOptions,
    RetryPolicy,
    Transport,
)
from naija_pay.core.money import BASIS_POINTS_TOTAL, Money
from naija_pay.core.redact import looks_like_live_key, looks_like_test_key
from naija_pay.core.signatures import SCHEMES, VerificationResult, verify_signature
from naija_pay.providers.paystack.capabilities import (
    CHANNEL_TO_PAYSTACK,
    NOT_YET_IMPLEMENTED,
    PAYSTACK_BASE_URL,
    PAYSTACK_PROVIDER_NAME,
    PAYSTACK_WEBHOOK_IPS,
    paystack_capabilities,
)
from naija_pay.providers.paystack.normalise import (
    BankAccount,
    Payout,
    Refund,
    Split,
    SplitAccount,
    Transaction,
    VirtualAccount,
    enrich,
    to_payout,
    to_refund,
    to_split,
    to_split_account,
    to_transaction,
    to_virtual_account,
)

#: Transfer references: min 16 chars, lowercase letters, digits, dash, underscore.
_TRANSFER_REFERENCE = re.compile(r"^[a-z0-9_-]{16,50}$")


def _classify_paystack_error(
    status: int, body: Any
) -> tuple[type[NaijaPayError], str | None] | None:
    """Paystack's error codes, mapped onto our typed errors.

    Paystack mostly uses correct HTTP statuses, so this only covers the cases where the
    status alone is ambiguous -- chiefly the many different things a 400 can mean.
    """
    message = ""
    if isinstance(body, dict) and isinstance(body.get("message"), str):
        message = body["message"].lower()

    if "duplicate" in message or "already exist" in message:
        return (DuplicateReferenceError, None)
    # Paystack's actual wording for an empty balance is "Your balance is not enough to
    # fulfil this request", which contains neither "insufficient" nor anything else we
    # were matching on. Found by running against the sandbox; see fixtures SANDBOX.md.
    if "insufficient" in message or "balance is not enough" in message:
        return (InsufficientFundsError, None)
    # A feature that exists in the API but is not switched on for this integration.
    # Dedicated Virtual Accounts are the common case: Paystack must enable them per
    # business. A configuration problem, not an authentication one.
    if "not available for your business" in message:
        raw = body.get("message") if isinstance(body, dict) else ""
        return (
            ConfigurationError,
            f"paystack: {raw} -- this feature exists but is not enabled on your "
            "integration. Ask Paystack support to enable it for your business; the API "
            "key is fine.",
        )
    if "bvn" in message or "identification" in message:
        return (KycRequiredError, None)
    if status == 404 or "not found" in message:
        return (NotFoundError, None)
    if status == 400:
        return (ValidationError, None)
    return None


def _is_production_environment() -> bool:
    value = os.environ.get("NODE_ENV") or os.environ.get("ENV") or os.environ.get("ENVIRONMENT")
    return (value or "").lower() == "production"


def _default_live_key_warning(message: str) -> None:
    # Deliberately loud, and on stderr, so it is not lost in normal output.
    print(f"\n*** {message} ***\n", file=sys.stderr)


class PaystackProvider:
    """Paystack, behind naija-pay's normalised surface."""

    def __init__(
        self,
        *,
        secret_key: str,
        environment: str | None = None,
        timeout_seconds: float = 30.0,
        retry: RetryPolicy | None = None,
        on_log: Callable[[dict[str, Any]], None] | None = None,
        transport: Transport | None = None,
        sleep: Callable[[float], None] | None = None,
        on_live_key_warning: Callable[[str], None] | None = None,
    ) -> None:
        key = (secret_key or "").strip()
        if not key:
            raise ConfigurationError(
                "paystack: secret_key is required", provider=PAYSTACK_PROVIDER_NAME
            )
        if not key.startswith("sk_"):
            raise ConfigurationError(
                "paystack: secret_key must be a secret key beginning sk_test_ or sk_live_. "
                "A public key (pk_) cannot authorise server-side calls.",
                provider=PAYSTACK_PROVIDER_NAME,
            )

        declared = environment or ("live" if looks_like_live_key(key) else "test")

        # The check that matters, because Paystack serves test and live from one host.
        if declared == "test" and looks_like_live_key(key):
            raise ConfigurationError(
                "paystack: a LIVE secret key was supplied while environment is 'test'. "
                "Paystack serves test and live from the same host, so this would move real "
                "money. Use a sk_test_ key, or set environment to 'live' deliberately.",
                provider=PAYSTACK_PROVIDER_NAME,
            )
        if declared == "live" and looks_like_test_key(key):
            raise ConfigurationError(
                "paystack: a TEST secret key was supplied while environment is 'live'.",
                provider=PAYSTACK_PROVIDER_NAME,
            )

        if declared == "live" and not _is_production_environment():
            warn = on_live_key_warning or _default_live_key_warning
            warn(
                "paystack: using a LIVE key outside a production environment. Real money will move."
            )

        self.name = PAYSTACK_PROVIDER_NAME
        self.capabilities = paystack_capabilities
        self.not_yet_implemented = NOT_YET_IMPLEMENTED
        self._secret_key = key

        if transport is None:
            # Imported lazily so the adapter can be constructed, and its validation
            # exercised, without httpx present.
            from naija_pay.core.transport import HttpxTransport

            transport = HttpxTransport()

        options = HttpClientOptions(
            provider=PAYSTACK_PROVIDER_NAME,
            base_url=PAYSTACK_BASE_URL,
            transport=transport,
            headers={"authorization": f"Bearer {key}"},
            timeout_seconds=timeout_seconds,
            classify_error=_classify_paystack_error,
        )
        if retry is not None:
            options.retry = retry
        if on_log is not None:
            options.on_log = on_log
        if sleep is not None:
            options.sleep = sleep

        self._http = HttpClient(options)

    # ---------------------------------------------------------------- plumbing

    def _call(
        self,
        *,
        method: str,
        path: str,
        operation: str,
        safety: str,
        body: Any = None,
        query: Mapping[str, Any] | None = None,
        reference: str | None = None,
    ) -> tuple[Any, str, Any]:
        """Unwrap Paystack's ``{status, message, data}`` envelope."""
        assert_supported(self.capabilities, operation)

        response = self._http.request(
            method=method,  # type: ignore[arg-type]
            path=path,
            operation=operation,
            safety=safety,  # type: ignore[arg-type]
            body=body,
            query=query,
            reference=reference,
        )

        envelope = response.body if isinstance(response.body, dict) else {}
        # Paystack normally signals failure with an HTTP status, but `status: false` on a
        # 2xx is possible, and treating that as success would be the worst kind of bug.
        if envelope.get("status") is False:
            error_class = error_class_for_status(response.status)
            message = envelope.get("message") or "paystack reported a failure"
            raise error_class(
                message,
                provider=PAYSTACK_PROVIDER_NAME,
                operation=operation,
                http_status=response.status,
                provider_message=envelope.get("message"),
                request_id=response.request_id,
            )

        return envelope.get("data"), envelope.get("message") or "", envelope.get("meta")

    # ------------------------------------------------------------- collections

    def create_checkout(
        self,
        *,
        amount: Money,
        email: str,
        reference: str | None = None,
        channels: Sequence[str] | None = None,
        callback_url: str | None = None,
        metadata: Mapping[str, Any] | None = None,
        split_code: str | None = None,
        subaccount: str | None = None,
    ) -> dict[str, Any]:
        """Initialize a transaction and return the hosted checkout URL."""
        paystack_channels: list[str] | None = None
        if channels is not None:
            unsupported = [c for c in channels if c not in CHANNEL_TO_PAYSTACK]
            if unsupported:
                raise ValidationError(
                    "paystack does not support the channel(s): "
                    f"{', '.join(unsupported)}. See the capability matrix in PROVIDERS.md.",
                    provider=PAYSTACK_PROVIDER_NAME,
                    operation="checkout.create",
                )
            paystack_channels = [CHANNEL_TO_PAYSTACK[c] for c in channels]

        payload: dict[str, Any] = {
            # Paystack documents amount as a string on this endpoint, unlike elsewhere.
            "amount": str(amount.amount),
            "currency": amount.currency,
            "email": email,
        }
        if reference is not None:
            payload["reference"] = reference
        if paystack_channels:
            payload["channels"] = paystack_channels
        if callback_url is not None:
            payload["callback_url"] = callback_url
        if metadata is not None:
            payload["metadata"] = json.dumps(metadata, separators=(",", ":"))
        if split_code is not None:
            payload["split_code"] = split_code
        if subaccount is not None:
            payload["subaccount"] = subaccount

        data, _, _ = self._call(
            method="POST",
            path="/transaction/initialize",
            operation="checkout.create",
            # Safe to retry: Paystack keys off our reference, so a replay returns the
            # same checkout rather than creating a second one.
            safety="safe",
            body=payload,
        )
        return {
            "reference": data["reference"],
            "checkout_url": data["authorization_url"],
            "access_code": data["access_code"],
            "provider": PAYSTACK_PROVIDER_NAME,
            "raw": data,
        }

    def verify_transaction(self, reference: str) -> Transaction:
        """Verify a transaction by the reference you used."""
        data, _, _ = self._call(
            method="GET",
            path=f"/transaction/verify/{reference}",
            operation="transactions.verify",
            safety="safe",
        )
        return to_transaction(data)

    def list_transactions(self, **query: Any) -> dict[str, Any]:
        data, _, meta = self._call(
            method="GET",
            path="/transaction",
            operation="transactions.list",
            safety="safe",
            query=query,
        )
        rows = data if isinstance(data, list) else []
        return {"transactions": [to_transaction(row) for row in rows], "meta": meta}

    def create_refund(
        self,
        *,
        transaction: str,
        amount: Money | None = None,
        merchant_note: str | None = None,
        customer_note: str | None = None,
    ) -> Refund:
        """Refund a transaction, fully or partially."""
        payload: dict[str, Any] = {"transaction": transaction}
        if amount is not None:
            payload["amount"] = amount.amount
            payload["currency"] = amount.currency
        if merchant_note is not None:
            payload["merchant_note"] = merchant_note
        if customer_note is not None:
            payload["customer_note"] = customer_note

        data, _, _ = self._call(
            method="POST",
            path="/refund",
            operation="refunds.create",
            # Never retried: a replayed refund could refund twice.
            safety="money-moving",
            reference=transaction,
            body=payload,
        )
        return to_refund(data)

    # --------------------------------------------------------- virtual accounts

    def create_static_virtual_account(
        self,
        *,
        email: str,
        first_name: str,
        last_name: str,
        phone: str,
        preferred_bank: str,
        bvn: str | None = None,
        country: str = "NG",
        split_code: str | None = None,
        subaccount: str | None = None,
    ) -> dict[str, Any]:
        """Assign a Dedicated Virtual Account to a customer.

        Paystack's ``assign`` endpoint creates the customer, validates them and assigns
        the account in one call, and returns only an acknowledgement -- the account
        arrives by webhook. We therefore return a pending record rather than pretending
        to have an account number.
        """
        assert_supported(self.capabilities, "virtualAccounts.createStatic")

        if not bvn:
            # Fail locally with the actionable error rather than an opaque rejection.
            raise KycRequiredError(
                "paystack: a BVN is required to assign a dedicated virtual account "
                "under CBN rules.",
                provider=PAYSTACK_PROVIDER_NAME,
                operation="virtualAccounts.createStatic",
                required=["bvn"],
            )

        payload: dict[str, Any] = {
            "email": email,
            "first_name": first_name,
            "last_name": last_name,
            "phone": phone,
            "preferred_bank": preferred_bank,
            "country": country,
            "bvn": bvn,
        }
        if split_code is not None:
            payload["split_code"] = split_code
        if subaccount is not None:
            payload["subaccount"] = subaccount

        data, message, _ = self._call(
            method="POST",
            path="/dedicated_account/assign",
            operation="virtualAccounts.createStatic",
            safety="safe",
            body=payload,
        )
        return {"status": "pending", "message": message, "raw": data}

    def get_virtual_account(self, account_id: str) -> VirtualAccount:
        data, _, _ = self._call(
            method="GET",
            path=f"/dedicated_account/{account_id}",
            operation="virtualAccounts.get",
            safety="safe",
        )
        return to_virtual_account(data)

    def list_virtual_accounts(self, **query: Any) -> tuple[VirtualAccount, ...]:
        data, _, _ = self._call(
            method="GET",
            path="/dedicated_account",
            operation="virtualAccounts.list",
            safety="safe",
            query=query,
        )
        rows = data if isinstance(data, list) else []
        return tuple(to_virtual_account(row) for row in rows)

    def deactivate_virtual_account(self, account_id: str) -> VirtualAccount:
        data, _, _ = self._call(
            method="DELETE",
            path=f"/dedicated_account/{account_id}",
            operation="virtualAccounts.deactivate",
            safety="unsafe",
        )
        return to_virtual_account(data)

    # ------------------------------------------------------ splits/subaccounts

    def create_split_account(
        self,
        *,
        business_name: str,
        bank_code: str,
        account_number: str,
        percentage_charge: float,
        description: str | None = None,
    ) -> SplitAccount:
        """Create a subaccount that settles to a vendor's own bank account."""
        payload: dict[str, Any] = {
            "business_name": business_name,
            # Paystack's reference lists `bank_code` while its own cURL sample sends
            # `settlement_bank`. Both are sent, which costs nothing and tolerates either.
            "bank_code": bank_code,
            "settlement_bank": bank_code,
            "account_number": account_number,
            "percentage_charge": percentage_charge,
        }
        if description is not None:
            payload["description"] = description

        data, _, _ = self._call(
            method="POST",
            path="/subaccount",
            operation="splitAccounts.create",
            safety="safe",
            body=payload,
        )
        return to_split_account(data)

    def list_split_accounts(self) -> tuple[SplitAccount, ...]:
        data, _, _ = self._call(
            method="GET",
            path="/subaccount",
            operation="splitAccounts.list",
            safety="safe",
        )
        rows = data if isinstance(data, list) else []
        return tuple(to_split_account(row) for row in rows)

    def create_split(
        self,
        *,
        name: str,
        split_type: str,
        currency: str,
        parties: Sequence[Mapping[str, Any]],
        bearer_type: str = "all-proportional",
        bearer_subaccount: str | None = None,
    ) -> Split:
        """Create a transaction split.

        Shares arrive as basis points, because a percentage held as a float is how
        rounding errors get into money. Paystack wants a percentage, so basis points are
        divided by 100 -- exact for every value, since 10000 bps is 100%.
        """
        if not parties:
            raise ValidationError(
                "paystack: a split needs at least one party",
                provider=PAYSTACK_PROVIDER_NAME,
                operation="splits.create",
            )

        for party in parties:
            share = party.get("share")
            if isinstance(share, bool) or not isinstance(share, int) or share < 0:
                raise ValidationError(
                    f'paystack: the share for "{party.get("account")}" must be a '
                    "non-negative integer (basis points for a percentage split, minor "
                    f"units for a flat one), got {share}",
                    provider=PAYSTACK_PROVIDER_NAME,
                    operation="splits.create",
                )

        if split_type == "percentage":
            total = sum(int(p["share"]) for p in parties)
            if total > BASIS_POINTS_TOTAL:
                raise ValidationError(
                    f"paystack: the split shares total {total} basis points, which is "
                    "more than 100%",
                    provider=PAYSTACK_PROVIDER_NAME,
                    operation="splits.create",
                )

        payload: dict[str, Any] = {
            "name": name,
            "type": split_type,
            "currency": currency,
            "subaccounts": [
                {
                    "subaccount": party["account"],
                    "share": (
                        int(party["share"]) / 100
                        if split_type == "percentage"
                        else int(party["share"])
                    ),
                }
                for party in parties
            ],
            "bearer_type": bearer_type,
        }
        if bearer_subaccount is not None:
            payload["bearer_subaccount"] = bearer_subaccount

        data, _, _ = self._call(
            method="POST",
            path="/split",
            operation="splits.create",
            safety="safe",
            body=payload,
        )
        return to_split(data)

    def list_splits(self) -> tuple[Split, ...]:
        data, _, _ = self._call(method="GET", path="/split", operation="splits.list", safety="safe")
        rows = data if isinstance(data, list) else []
        return tuple(to_split(row) for row in rows)

    # ------------------------------------------------------------------ payouts

    def list_banks(self, *, country: str = "nigeria", per_page: int = 1_000) -> tuple[Any, ...]:
        data, _, _ = self._call(
            method="GET",
            path="/bank",
            operation="banks.list",
            safety="safe",
            query={"country": country, "perPage": per_page},
        )
        return tuple(data) if isinstance(data, list) else ()

    def resolve_account(self, *, account_number: str, bank_code: str) -> BankAccount:
        """Resolve an account number to its registered name."""
        data, _, _ = self._call(
            method="GET",
            path="/bank/resolve",
            operation="banks.resolveAccount",
            safety="safe",
            query={"account_number": account_number, "bank_code": bank_code},
        )
        return enrich(
            account_number=data["account_number"],
            account_name=data["account_name"],
            bank_code=bank_code,
        )

    def create_payout(
        self,
        *,
        amount: Money,
        account_number: str,
        bank_code: str,
        account_name: str,
        reference: str,
        reason: str | None = None,
    ) -> Payout:
        """Send money to a bank account.

        Creates the transfer recipient first, which Paystack requires and which
        de-duplicates on the account number, so repeating it is harmless.
        """
        assert_supported(self.capabilities, "payouts.create")

        if not _TRANSFER_REFERENCE.match(reference):
            raise ValidationError(
                f'paystack: the transfer reference "{reference}" is not acceptable. '
                "Paystack requires 16 to 50 characters, using only lowercase letters, "
                "digits, dash and underscore.",
                provider=PAYSTACK_PROVIDER_NAME,
                operation="payouts.create",
            )

        # Creating the recipient is idempotent on the account number, so it is safe.
        recipient, _, _ = self._call(
            method="POST",
            path="/transferrecipient",
            operation="payouts.create",
            safety="safe",
            body={
                "type": "nuban",
                "name": account_name,
                "account_number": account_number,
                "bank_code": bank_code,
                "currency": amount.currency,
            },
        )

        payload: dict[str, Any] = {
            "source": "balance",
            "amount": amount.amount,
            "currency": amount.currency,
            "recipient": recipient["recipient_code"],
            "reference": reference,
        }
        if reason is not None:
            payload["reason"] = reason

        data, _, _ = self._call(
            method="POST",
            path="/transfer",
            operation="payouts.create",
            # The money-moving call. Never retried, never failed over.
            safety="money-moving",
            reference=reference,
            body=payload,
        )
        return to_payout(data)

    def get_payout(self, reference: str) -> Payout:
        data, _, _ = self._call(
            method="GET",
            path=f"/transfer/verify/{reference}",
            operation="payouts.status",
            safety="safe",
        )
        return to_payout(data)

    def get_balance(self) -> tuple[dict[str, Any], ...]:
        data, _, _ = self._call(
            method="GET", path="/balance", operation="balance.get", safety="safe"
        )
        rows = data if isinstance(data, list) else []
        return tuple(
            {"amount": row.get("balance"), "currency": row.get("currency")} for row in rows
        )

    # ----------------------------------------------------------------- webhooks

    def verify_webhook(self, *, body: bytes, headers: Mapping[str, str]) -> VerificationResult:
        """Verify a webhook from Paystack.

        ``body`` must be the raw bytes exactly as received. Parsing or re-serialising
        first guarantees a mismatch, and it is the single most common cause of "my
        signature does not verify".
        """
        assert_supported(self.capabilities, "webhooks.verify")
        return verify_signature(
            scheme=SCHEMES["paystack"],
            body=body,
            headers=headers,
            secret=self._secret_key,
        )

    def is_known_webhook_ip(self, ip: str) -> bool:
        """Whether a request came from one of Paystack's documented webhook IPs.

        Offered as a second check alongside the signature, never as a replacement: an IP
        allowlist says where a request came from, not that its contents are intact.
        """
        return ip in PAYSTACK_WEBHOOK_IPS


def paystack(**options: Any) -> PaystackProvider:
    """Create a Paystack provider."""
    return PaystackProvider(**options)


__all__ = ["PaystackProvider", "paystack"]
