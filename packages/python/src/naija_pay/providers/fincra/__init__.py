"""The Fincra adapter.

Read from Fincra's current documentation on 2026-11-11, endpoint by endpoint from the
OpenAPI document each reference page embeds. See ``capabilities.py`` for what is supported
and why, and PROVIDERS.md for the findings.

Six Fincra-specific traps this adapter absorbs:

1. **The auth header is not ``Authorization``.** Fincra takes ``api-key: <secret>``. A
   Bearer token is simply ignored, and the reply is "No API key found in request".
2. **Two envelope keys for one meaning.** ``{"status": true}`` on checkout endpoints,
   ``{"success": true}`` on payouts, banks and wallets. Both are accepted.
3. **``success: true`` does not mean the payout settled.** Fincra's own documentation says
   so: it means the request was accepted. ``data.status`` is the answer, and ``processing``
   is a pending payout.
4. **Six decimal places.** Fincra reports fees like ``9090.909091`` and balances like
   ``4145.558824``. No currency has six decimal places, so an amount that cannot be
   represented exactly in minor units is reported as None rather than rounded, and the
   exact figure stays in ``raw``.
5. **A payout can be waiting for a document.** ``isDocumentRequired`` on a created payout
   means nothing moves until a file is uploaded -- Fincra's equivalent of Monnify's OTP
   gate.
6. **The webhook signature is over a re-serialisation.** Fincra documents HMAC-SHA512 over
   ``JSON.stringify({event, data})``, which is not the raw bytes. ``verify_webhook`` tries
   the raw body first and says which input matched.

Mirrors ``packages/ts/src/providers/fincra/index.ts``.
"""

from __future__ import annotations

import json
import os
import sys
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from urllib.parse import quote

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
from naija_pay.core.http import HttpClient, HttpClientOptions, RetryPolicy, Transport
from naija_pay.core.money import Money, major_to_string, to_major
from naija_pay.core.signatures import (
    SCHEMES,
    compute_signature,
    constant_time_equal,
)
from naija_pay.providers.fincra.capabilities import (
    CHANNEL_TO_FINCRA,
    FINCRA_LIVE_BASE_URL,
    FINCRA_NGN_VIRTUAL_ACCOUNT_CHANNELS,
    FINCRA_PROVIDER_NAME,
    FINCRA_SANDBOX_BASE_URL,
    NOT_YET_IMPLEMENTED,
    fincra_capabilities,
)
from naija_pay.providers.fincra.normalise import (
    Bank,
    BankAccount,
    BvnVerification,
    Page,
    Payout,
    Refund,
    Transaction,
    VirtualAccount,
    WalletBalance,
    enrich,
    to_bank,
    to_bvn_verification,
    to_page,
    to_payout,
    to_refund,
    to_transaction,
    to_virtual_account,
    to_wallet_balance,
)

_NGN_VIRTUAL_ACCOUNT_CURRENCY = "NGN"


def _classify_fincra_error(status: int, body: Any) -> tuple[type[NaijaPayError], str | None] | None:
    """Fincra's error wording, mapped onto our typed errors.

    Fincra's own phrasing: "Invalid authentication credentials" and "No API key found in
    request" where Paystack says "Invalid key". Each provider matches its own strings.
    """
    raw = body.get("message") if isinstance(body, dict) else None
    message = raw.lower() if isinstance(raw, str) else ""

    if "duplicate" in message or "already exists" in message:
        return (DuplicateReferenceError, None)
    if "insufficient" in message or "balance" in message:
        return (InsufficientFundsError, None)
    if "bvn" in message or "kyc" in message or "verification" in message:
        return (KycRequiredError, None)
    # Fincra gates products per business and whitelists IPs, and says so in prose.
    # Reported as configuration, not authentication: the key is fine.
    if (
        "not enabled" in message
        or "not allowed" in message
        or "whitelist" in message
        or "contact support" in message
    ):
        return (
            ConfigurationError,
            f"fincra: {raw} -- this is a configuration or entitlement problem rather than "
            "a bad key. Fincra gates products per business and can also require your "
            "server's IP to be whitelisted under Settings.",
        )
    if status == 404 or "not found" in message:
        return (NotFoundError, None)
    if status in (400, 422):
        return (ValidationError, None)
    return None


def _is_production_environment() -> bool:
    value = os.environ.get("NODE_ENV") or os.environ.get("ENV") or os.environ.get("ENVIRONMENT")
    return (value or "").lower() == "production"


def _default_live_key_warning(message: str) -> None:
    # Deliberately loud, and on stderr, so it is not lost in normal output.
    print(f"\n*** {message} ***\n", file=sys.stderr)


def _canonical_fincra_payload(body: bytes) -> bytes | None:
    """``{event, data}`` re-serialised compactly, as Fincra's own samples compute it.

    Returns None when the body is not JSON or carries neither field, in which case there
    is nothing to compare and the caller falls through to a failure.
    """
    try:
        parsed = json.loads(body.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None
    if not isinstance(parsed, dict):
        return None
    if "event" not in parsed and "data" not in parsed:
        return None

    # Only these two keys, in this order, which is what Fincra's samples pass to
    # JSON.stringify, with the separators their Python sample pins.
    return json.dumps(
        {"event": parsed.get("event"), "data": parsed.get("data")},
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")


@dataclass(frozen=True, slots=True)
class FincraVerificationResult:
    """A verification result, plus which input the signature actually covered."""

    verified: bool
    strength: str
    reason: str | None
    #: ``raw-body``, ``canonical-reserialisation``, or None when nothing matched.
    matched_input: str | None


class FincraProvider:
    """Fincra, behind naija-pay's normalised surface."""

    def __init__(
        self,
        *,
        secret_key: str,
        public_key: str | None = None,
        business_id: str | None = None,
        webhook_secret_key: str | None = None,
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
                "fincra: secret_key is required. It is the value sent as the api-key "
                "header, from Settings > API keys and webhook Configuration on the "
                "dashboard.",
                provider=FINCRA_PROVIDER_NAME,
            )

        declared = environment or "test"
        if declared == "live" and not _is_production_environment():
            warn = on_live_key_warning or _default_live_key_warning
            warn(
                "fincra: environment is 'live' outside a production environment, so this "
                "client is pointed at api.fincra.com. Real money will move. Fincra "
                "publishes no key prefix, so the environment is the only signal and "
                "nothing else can catch this."
            )

        self.name = FINCRA_PROVIDER_NAME
        self.capabilities = fincra_capabilities
        self.not_yet_implemented = NOT_YET_IMPLEMENTED
        self._business_id = (business_id or "").strip() or None
        self._webhook_secret_key = (webhook_secret_key or "").strip() or None

        if transport is None:
            # Imported lazily so the adapter can be constructed, and its validation
            # exercised, without httpx present.
            from naija_pay.core.transport import HttpxTransport

            transport = HttpxTransport()

        headers = {"api-key": key}
        if public_key:
            headers["x-pub-key"] = public_key.strip()
        if self._business_id:
            headers["x-business-id"] = self._business_id

        options = HttpClientOptions(
            provider=FINCRA_PROVIDER_NAME,
            base_url=FINCRA_LIVE_BASE_URL if declared == "live" else FINCRA_SANDBOX_BASE_URL,
            transport=transport,
            # Not `authorization`. Fincra ignores a Bearer token entirely.
            headers=headers,
            timeout_seconds=timeout_seconds,
            classify_error=_classify_fincra_error,
        )
        if retry is not None:
            options.retry = retry
        if on_log is not None:
            options.on_log = on_log
        if sleep is not None:
            options.sleep = sleep

        self._http = HttpClient(options)

    # ----------------------------------------------------------------- plumbing

    def _call(
        self,
        *,
        method: str,
        path: str,
        operation: str,
        safety: str,
        body: Any = None,
        query: Mapping[str, Any] | None = None,
        headers: Mapping[str, str] | None = None,
        reference: str | None = None,
    ) -> tuple[Any, str]:
        """Unwrap Fincra's envelope, which has two names for its one success field.

        ``status`` on checkout, ``success`` elsewhere. Either being explicitly false is a
        failure; both being absent is treated as success, so an endpoint that spells it a
        third way does not fail every call.
        """
        assert_supported(self.capabilities, operation)

        response = self._http.request(
            method=method,  # type: ignore[arg-type]
            path=path,
            operation=operation,
            safety=safety,  # type: ignore[arg-type]
            body=body,
            query=query,
            headers=headers,
            reference=reference,
        )

        envelope = response.body if isinstance(response.body, dict) else {}
        ok = envelope.get("success")
        if ok is None:
            ok = envelope.get("status")

        if ok is False or ok in ("false", "error"):
            classified = _classify_fincra_error(response.status, envelope)
            error_class = classified[0] if classified else error_class_for_status(response.status)
            message = (
                (classified[1] if classified else None)
                or envelope.get("message")
                or "fincra reported a failure"
            )
            raise error_class(
                message,
                provider=FINCRA_PROVIDER_NAME,
                operation=operation,
                http_status=response.status,
                provider_message=envelope.get("message"),
                request_id=response.request_id,
            )

        return envelope.get("data"), envelope.get("message") or ""

    def _require_business_id(self, operation: str) -> str:
        if self._business_id is None:
            raise ConfigurationError(
                "fincra: business_id is required for this call. It identifies your "
                "business, differs between sandbox and live, and get_business() will tell "
                "you yours.",
                provider=FINCRA_PROVIDER_NAME,
                operation=operation,
            )
        return self._business_id

    def _assert_supported_currency(self, amount: Money, operation: str) -> None:
        supported = self.capabilities.currencies or ()
        if amount.currency not in supported:
            raise ValidationError(
                f"fincra: {amount.currency} is not one of the currencies Fincra documents "
                f"({', '.join(supported)}).",
                provider=FINCRA_PROVIDER_NAME,
                operation=operation,
            )

    # --------------------------------------------------------------- collections

    def create_checkout(
        self,
        *,
        amount: Money,
        email: str,
        name: str,
        reference: str,
        phone: str | None = None,
        channels: Sequence[str] | None = None,
        default_channel: str | None = None,
        callback_url: str | None = None,
        fee_bearer: str | None = None,
        metadata: Mapping[str, Any] | None = None,
        quote_reference: str | None = None,
    ) -> dict[str, Any]:
        """Create a hosted checkout and return its link.

        ``reference`` is your own and comes back as ``merchantReference``, which is what
        ``verify_transaction`` takes.
        """
        assert_supported(self.capabilities, "checkout.create")
        self._assert_supported_currency(amount, "checkout.create")

        payment_methods: list[str] | None = None
        if channels is not None:
            unsupported = [c for c in channels if c not in CHANNEL_TO_FINCRA]
            if unsupported:
                raise ValidationError(
                    f"fincra does not support the channel(s): {', '.join(unsupported)}. "
                    "See the capability matrix in PROVIDERS.md.",
                    provider=FINCRA_PROVIDER_NAME,
                    operation="checkout.create",
                )
            payment_methods = [CHANNEL_TO_FINCRA[c] for c in channels]

        default_method: str | None = None
        if default_channel is not None:
            if default_channel not in CHANNEL_TO_FINCRA:
                raise ValidationError(
                    f"fincra does not support the channel: {default_channel}.",
                    provider=FINCRA_PROVIDER_NAME,
                    operation="checkout.create",
                )
            default_method = CHANNEL_TO_FINCRA[default_channel]

        customer: dict[str, Any] = {"name": name, "email": email}
        if phone is not None:
            customer["phoneNumber"] = phone

        payload: dict[str, Any] = {
            "currency": amount.currency,
            # Decimal major units, converted and round-trip-checked. Never amount.amount.
            "amount": to_major(amount),
            "customer": customer,
            "reference": reference,
        }
        if payment_methods is not None:
            payload["paymentMethods"] = payment_methods
        if default_method is not None:
            payload["defaultPaymentMethod"] = default_method
        if callback_url is not None:
            payload["redirectUrl"] = callback_url
        if fee_bearer is not None:
            payload["feeBearer"] = fee_bearer
        if quote_reference is not None:
            payload["quoteReference"] = quote_reference
        if metadata is not None:
            payload["metadata"] = dict(metadata)

        data, _message = self._call(
            method="POST",
            path="/checkout/payments",
            operation="checkout.create",
            # Keyed on your reference, so a replay returns a link for the same payment.
            safety="safe",
            body=payload,
        )

        bag = data if isinstance(data, dict) else {}
        return {
            "reference": reference,
            "checkout_url": bag.get("link") or "",
            "pay_code": bag.get("payCode"),
            "provider": FINCRA_PROVIDER_NAME,
            "raw": data,
        }

    def verify_transaction(self, reference: str) -> Transaction:
        """Verify a payment by **your** reference.

        Fincra has no verify-by-its-own-reference route for checkout, which is the
        opposite of Flutterwave. The ``x-business-id`` header is required on this call, and
        only this call, so a client configured without a business id is told so here.
        """
        business_id = self._require_business_id("transactions.verify")
        data, _message = self._call(
            method="GET",
            path=f"/checkout/payments/merchant-reference/{quote(reference, safe='')}",
            operation="transactions.verify",
            safety="safe",
            headers={"x-business-id": business_id},
        )
        return to_transaction(data)

    # ------------------------------------------------------------------ refunds

    def create_refund(self, collection_reference: str) -> Refund:
        """Refund a collection in full.

        Fincra takes only the collection's reference: there is no amount field, so a
        **partial refund is not possible** through this API. Said plainly here because the
        absence is easy to mistake for an omission in the adapter.
        """
        data, _message = self._call(
            method="POST",
            path="/collections/refund",
            operation="refunds.create",
            # Moves money back to a customer. Never retried.
            safety="money-moving",
            reference=collection_reference,
            body={"transReference": collection_reference},
        )
        return to_refund(data)

    def get_refund(self, reference: str) -> Refund:
        data, _message = self._call(
            method="GET",
            path=f"/collections/refund/{quote(reference, safe='')}",
            operation="refunds.status",
            safety="safe",
        )
        return to_refund(data)

    def list_refunds(self) -> Page[Refund]:
        data, _message = self._call(
            method="GET",
            path="/collections/refund",
            operation="refunds.status",
            safety="safe",
            query={"business": self._require_business_id("refunds.status")},
        )
        return to_page(data, to_refund)

    # ---------------------------------------------------------- virtual accounts

    def create_virtual_account(
        self,
        *,
        currency: str,
        account_type: str,
        reference: str | None = None,
        first_name: str | None = None,
        last_name: str | None = None,
        business_name: str | None = None,
        bvn_name: str | None = None,
        email: str | None = None,
        phone: str | None = None,
        bvn: str | None = None,
        channel: str | None = None,
    ) -> VirtualAccount:
        """Request a permanent virtual account.

        NGN requires a BVN, and a corporate account additionally requires
        ``business_name`` and ``bvn_name``, which Fincra matches against the name on the
        BVN. Both are enforced here rather than by a provider rejection that names no
        field.

        The ``channel`` is the partner bank. Two of the nine Fincra publishes are disabled
        -- ``bold`` and ``providus`` -- and asking for one of those is refused locally with
        the table as the reason.
        """
        assert_supported(self.capabilities, "virtualAccounts.createStatic")
        code = currency.upper()

        if code == _NGN_VIRTUAL_ACCOUNT_CURRENCY and not bvn:
            raise KycRequiredError(
                "fincra: an NGN virtual account requires a bvn. Fincra's own documentation "
                "is explicit about it, and the request is rejected without one.",
                provider=FINCRA_PROVIDER_NAME,
                operation="virtualAccounts.createStatic",
                required=["bvn"],
            )

        if account_type == "corporate" and (not business_name or not bvn_name):
            raise ValidationError(
                "fincra: a corporate virtual account requires both business_name and "
                "bvn_name, and bvn_name must match the name on the BVN. Fincra rejects a "
                "mismatch without saying which field was wrong.",
                provider=FINCRA_PROVIDER_NAME,
                operation="virtualAccounts.createStatic",
            )

        if account_type == "individual" and (not first_name or not last_name):
            raise ValidationError(
                "fincra: an individual virtual account requires both first_name and last_name.",
                provider=FINCRA_PROVIDER_NAME,
                operation="virtualAccounts.createStatic",
            )

        if channel is not None:
            if channel not in FINCRA_NGN_VIRTUAL_ACCOUNT_CHANNELS:
                published = ", ".join(FINCRA_NGN_VIRTUAL_ACCOUNT_CHANNELS)
                raise ValidationError(
                    f'fincra: "{channel}" is not one of the bank channels Fincra '
                    f"publishes ({published}).",
                    provider=FINCRA_PROVIDER_NAME,
                    operation="virtualAccounts.createStatic",
                )
            if not FINCRA_NGN_VIRTUAL_ACCOUNT_CHANNELS[channel]:
                raise ValidationError(
                    f'fincra: the "{channel}" bank channel is published as DISABLED in '
                    "Fincra's own documentation, so an account cannot be issued there. "
                    "Pick an enabled channel, or omit channel and let Fincra choose.",
                    provider=FINCRA_PROVIDER_NAME,
                    operation="virtualAccounts.createStatic",
                )

        kyc: dict[str, Any] = {}
        for field, value in (
            ("firstName", first_name),
            ("lastName", last_name),
            ("businessName", business_name),
            ("bvnName", bvn_name),
            ("email", email),
            ("phone", phone),
            ("bvn", bvn),
        ):
            if value is not None:
                kyc[field] = value

        payload: dict[str, Any] = {
            "currency": code,
            "accountType": account_type,
            "KYCInformation": kyc,
        }
        if channel is not None:
            payload["channel"] = channel
        if reference is not None:
            payload["merchantReference"] = reference

        data, _message = self._call(
            method="POST",
            path="/profile/virtual-accounts/requests",
            operation="virtualAccounts.createStatic",
            # Creates a KYC request. Not keyed on anything we own unless a reference is
            # given, so never repeated automatically.
            safety="unsafe",
            body=payload,
            reference=reference,
        )
        return to_virtual_account(data, reference=reference, kind="static")

    def create_dynamic_virtual_account(
        self,
        *,
        amount: Money,
        expires_at: datetime | str,
        reference: str | None = None,
        channel: str | None = None,
    ) -> VirtualAccount:
        """Request a temporary virtual account for one payment.

        Fincra takes the amount as a **string** on this one endpoint, while every other
        endpoint takes a number. ``expires_at`` is required.
        """
        assert_supported(self.capabilities, "virtualAccounts.createDynamic")
        if amount.currency != _NGN_VIRTUAL_ACCOUNT_CURRENCY:
            raise ValidationError(
                "fincra: a temporary virtual account is NGN only, which is what Fincra's "
                "documentation for this endpoint says.",
                provider=FINCRA_PROVIDER_NAME,
                operation="virtualAccounts.createDynamic",
            )

        expiry = expires_at.isoformat() if isinstance(expires_at, datetime) else expires_at

        payload: dict[str, Any] = {
            # A string, deliberately: Fincra's schema for this endpoint types amount as a
            # string, unlike every other endpoint. The conversion is still checked.
            "amount": major_to_string(amount),
            "expiresAt": expiry,
        }
        if reference is not None:
            payload["merchantReference"] = reference
        if channel is not None:
            payload["channel"] = channel

        data, _message = self._call(
            method="POST",
            path="/profile/virtual-accounts/transfer",
            operation="virtualAccounts.createDynamic",
            safety="unsafe",
            body=payload,
            reference=reference,
        )
        return to_virtual_account(data, reference=reference, kind="dynamic")

    def get_virtual_account(self, account_id: str) -> VirtualAccount:
        """One virtual account, by Fincra's ``_id``."""
        data, _message = self._call(
            method="GET",
            path=f"/profile/virtual-accounts/{quote(account_id, safe='')}",
            operation="virtualAccounts.get",
            safety="safe",
        )
        return to_virtual_account(data)

    def list_virtual_accounts(
        self,
        *,
        page: int | None = None,
        per_page: int | None = None,
        currency: str | None = None,
        status: str | None = None,
        account_type: str | None = None,
        reference: str | None = None,
    ) -> Page[VirtualAccount]:
        query: dict[str, Any] = {}
        if page is not None:
            query["page"] = page
        if per_page is not None:
            query["perPage"] = per_page
        if currency is not None:
            query["currency"] = currency
        if status is not None:
            query["status"] = status
        if account_type is not None:
            query["accountType"] = account_type
        if reference is not None:
            query["merchantReference"] = reference

        data, _message = self._call(
            method="GET",
            path="/profile/virtual-accounts",
            operation="virtualAccounts.list",
            safety="safe",
            query=query,
        )
        return to_page(data, to_virtual_account)

    def find_virtual_accounts_by_bvn(self, bvn: str) -> Page[VirtualAccount]:
        """Find a customer's virtual accounts by their BVN.

        Fincra masks the response: account numbers, names and emails come back as runs of
        asterisks. Useful for "does this person already have an account", not for reading
        the account number back.
        """
        data, _message = self._call(
            method="GET",
            path="/profile/virtual-accounts/bvn",
            operation="virtualAccounts.list",
            safety="safe",
            query={"bvn": bvn, "business": self._require_business_id("virtualAccounts.list")},
        )
        return to_page(data, to_virtual_account)

    def list_virtual_account_inflows(self, *, virtual_account_id: str) -> Page[Transaction]:
        """Collections that landed in one virtual account."""
        data, _message = self._call(
            method="GET",
            path="/collections",
            operation="virtualAccounts.listInflows",
            safety="safe",
            query={
                "business": self._require_business_id("virtualAccounts.listInflows"),
                "virtualAccount": virtual_account_id,
            },
        )
        return to_page(data, to_transaction)

    # ------------------------------------------------------------------ payouts

    def create_payout(
        self,
        *,
        amount: Money,
        reference: str,
        beneficiary: Mapping[str, Any],
        destination_currency: str | None = None,
        description: str | None = None,
        quote_reference: str | None = None,
        payment_destination: str = "bank_account",
    ) -> Payout:
        """Create a payout to a bank account.

        **``success: true`` does not mean the money arrived.** Fincra's documentation says
        so in as many words: it confirms the request was handled. The returned payout's
        ``status`` is the answer, and ``processing`` means pending.

        A cross-currency payout needs a ``quote_reference`` from Fincra's quote endpoint,
        and quotes expire in 30 seconds. Never retried, whatever the transport does.
        """
        self._assert_supported_currency(amount, "payouts.create")
        business = self._require_business_id("payouts.create")
        destination = (destination_currency or amount.currency).upper()

        if destination != amount.currency and quote_reference is None:
            raise ValidationError(
                f"fincra: a cross-currency payout ({amount.currency} to {destination}) "
                "requires a quote_reference. Generate one with Fincra's quote endpoint and "
                "send it within 30 seconds, which is how long a quote lasts.",
                provider=FINCRA_PROVIDER_NAME,
                operation="payouts.create",
            )

        recipient: dict[str, Any] = {
            "accountHolderName": beneficiary["account_holder_name"],
            "accountNumber": beneficiary["account_number"],
            "bankCode": beneficiary["bank_code"],
            "type": beneficiary.get("type") or "individual",
            "country": beneficiary.get("country") or "NG",
        }
        for field, source in (
            ("firstName", "first_name"),
            ("lastName", "last_name"),
            ("email", "email"),
            ("phone", "phone"),
        ):
            if beneficiary.get(source) is not None:
                recipient[field] = beneficiary[source]

        payload: dict[str, Any] = {
            "business": business,
            "sourceCurrency": amount.currency,
            "destinationCurrency": destination,
            # A number, not a string: Fincra's own page says "Do not send it as a string".
            "amount": to_major(amount),
            "customerReference": reference,
            "paymentDestination": payment_destination,
            "beneficiary": recipient,
        }
        if description is not None:
            payload["description"] = description
        if quote_reference is not None:
            payload["quoteReference"] = quote_reference

        data, _message = self._call(
            method="POST",
            path="/disbursements/payouts",
            operation="payouts.create",
            safety="money-moving",
            reference=reference,
            body=payload,
        )
        return to_payout(data)

    def get_payout(self, provider_reference: str) -> Payout:
        """A payout by Fincra's own reference."""
        data, _message = self._call(
            method="GET",
            path=f"/disbursements/payouts/reference/{quote(provider_reference, safe='')}",
            operation="payouts.status",
            safety="safe",
        )
        return to_payout(data)

    def get_payout_by_reference(self, reference: str) -> Payout:
        """A payout by **your** ``customerReference``, which is usually what you hold."""
        data, _message = self._call(
            method="GET",
            path=f"/disbursements/payouts/customer-reference/{quote(reference, safe='')}",
            operation="payouts.status",
            safety="safe",
        )
        return to_payout(data)

    def list_payouts(
        self,
        *,
        page: int | None = None,
        per_page: int | None = None,
        source_currency: str | None = None,
        destination_currency: str | None = None,
        status: str | None = None,
        date_from: str | None = None,
        date_to: str | None = None,
    ) -> Page[Payout]:
        """List payouts.

        Fincra's reference page documents this as a GET **with a request body**, which is
        not a thing most HTTP clients can send and not a thing most servers read. The
        filters are sent as query parameters instead, which is the only reading that can
        work over HTTP. That discrepancy is recorded in PROVIDERS.md and is first on the
        list for the sandbox harness to settle.
        """
        query: dict[str, Any] = {"business": self._require_business_id("payouts.status")}
        if page is not None:
            query["page"] = page
        if per_page is not None:
            query["perPage"] = per_page
        if source_currency is not None:
            query["sourceCurrency"] = source_currency
        if destination_currency is not None:
            query["destinationCurrency"] = destination_currency
        if status is not None:
            query["status"] = status
        if date_from is not None:
            query["dateFrom"] = date_from
        if date_to is not None:
            query["dateTo"] = date_to

        data, _message = self._call(
            method="GET",
            path="/disbursements/payouts",
            operation="payouts.status",
            safety="safe",
            query=query,
        )
        return to_page(data, to_payout)

    # -------------------------------------------------------- banks and balance

    def list_banks(
        self,
        *,
        country: str | None = None,
        currency: str | None = None,
        payment_destination: str | None = None,
    ) -> tuple[Bank, ...]:
        """Banks and payout providers for a country or currency.

        At least one of ``country`` or ``currency`` is required, and this defaults to
        Nigeria rather than making the common case say so.
        """
        query: dict[str, Any] = {}
        if country is not None:
            query["country"] = country
        elif currency is None:
            query["country"] = "NG"
        if currency is not None:
            query["currency"] = currency
        if payment_destination is not None:
            query["paymentDestination"] = payment_destination

        data, _message = self._call(
            method="GET",
            path="/core/banks",
            operation="banks.list",
            safety="safe",
            query=query,
        )
        return tuple(to_bank(item) for item in (data if isinstance(data, list) else []))

    def resolve_account(
        self,
        *,
        account_number: str,
        bank_code: str,
        type: str = "nuban",  # noqa: A002 - Fincra's own field name
        currency: str | None = None,
    ) -> BankAccount:
        """Resolve an account number to its holder's name.

        A **POST**, not a GET, and ``type`` is required: ``nuban`` for a Nigerian account
        number, or ``bank_account``, ``iban``, ``mobile_money`` or ``interac_etransfer``
        elsewhere. Fincra does not echo the bank code back on a NUBAN resolve, so the
        adapter carries the one you passed.
        """
        payload: dict[str, Any] = {
            "type": type,
            "accountNumber": account_number,
            "bankCode": bank_code,
        }
        if currency is not None:
            payload["currency"] = currency

        data, _message = self._call(
            method="POST",
            path="/core/accounts/resolve",
            operation="banks.resolveAccount",
            # A read, despite the verb.
            safety="safe",
            body=payload,
        )
        bag = data if isinstance(data, dict) else {}
        return enrich(
            account_number=bag.get("accountNumber") or account_number,
            account_name=bag.get("accountName") or "",
            bank_code=bank_code,
        )

    def get_balance(self) -> tuple[WalletBalance, ...]:
        """Every wallet balance, one per currency."""
        data, _message = self._call(
            method="GET",
            path="/wallets",
            operation="balance.get",
            safety="safe",
            query={"businessID": self._require_business_id("balance.get")},
        )
        return tuple(to_wallet_balance(item) for item in (data if isinstance(data, list) else []))

    def get_wallet(self, wallet_id: str) -> WalletBalance:
        """One wallet, by Fincra's wallet id."""
        data, _message = self._call(
            method="GET",
            path=f"/wallets/{quote(wallet_id, safe='')}",
            operation="balance.get",
            safety="safe",
        )
        return to_wallet_balance(data)

    def get_business(self) -> dict[str, Any]:
        """Your business profile, including the id every other call needs.

        The way to find your ``business_id`` when you do not have it: the ``_id`` in the
        result.
        """
        data, _message = self._call(
            method="GET",
            path="/profile/business/me",
            operation="balance.get",
            safety="safe",
        )
        bag = data if isinstance(data, dict) else {}
        return {"id": bag.get("_id"), "raw": data}

    # ----------------------------------------------------------------- identity

    def verify_bvn(self, bvn: str) -> BvnVerification:
        """Verify a BVN.

        Fincra returns a photograph of the person as base64. This adapter **drops it**: see
        ``to_bvn_verification``. A BVN is sensitive under NDPA 2023 and a photograph more
        so, so neither is logged and the photograph is not even carried in ``raw``.
        """
        data, _message = self._call(
            method="POST",
            path="/core/bvn-verification",
            operation="identity.verifyBvn",
            safety="safe",
            body={"bvn": bvn, "business": self._require_business_id("identity.verifyBvn")},
        )
        return to_bvn_verification(data)

    # ----------------------------------------------------------------- webhooks

    def verify_webhook(
        self, *, body: bytes, headers: Mapping[str, str]
    ) -> FincraVerificationResult:
        """Verify a webhook from Fincra.

        ``body`` must be the raw bytes exactly as received.

        Fincra's documented scheme is HMAC-SHA512, hex, in the ``signature`` header, keyed
        with the **webhook secret key** -- the third key on the dashboard, not the API
        secret and not the public key.

        The complication is what gets hashed. Fincra's samples hash
        ``JSON.stringify({event, data})`` -- a re-serialisation of the parsed payload. That
        is not the bytes that arrived, and whether it reproduces them depends on key order
        and on separators. So this method tries two inputs, in this order:

        1. **The raw body**, which is what a signature ought to cover and what matches when
           Fincra signs the bytes it is about to send.
        2. **A canonical compact re-serialisation** of ``{event, data}`` -- which is what
           their samples compute.

        ``matched_input`` says which one verified. A ``canonical-reserialisation`` match is
        a real verification, not a guess: the secret still had to be known. But it is worth
        knowing, because it means the signature does not cover the exact bytes.
        """
        assert_supported(self.capabilities, "webhooks.verify")

        if self._webhook_secret_key is None:
            raise ConfigurationError(
                "fincra: webhook_secret_key is required to verify webhooks. It is a THIRD "
                "key, separate from the secret and public keys -- the dashboard calls it "
                "the Webhook Encryption Key, under Settings > Portal Settings > Secret "
                "keys. Signing with the API secret key will never match.",
                provider=FINCRA_PROVIDER_NAME,
                operation="webhooks.verify",
            )

        lowered = {key.lower(): value for key, value in headers.items()}
        provided = lowered.get("signature")
        if not provided:
            return FincraVerificationResult(
                verified=False,
                strength="unverified",
                reason='the "signature" header is missing',
                matched_input=None,
            )

        expected_from_raw = compute_signature(SCHEMES["fincra"], body, self._webhook_secret_key)
        if constant_time_equal(provided, expected_from_raw):
            return FincraVerificationResult(
                verified=True, strength="full-body", reason=None, matched_input="raw-body"
            )

        canonical = _canonical_fincra_payload(body)
        if canonical is not None:
            expected_from_canonical = compute_signature(
                SCHEMES["fincra"], canonical, self._webhook_secret_key
            )
            if constant_time_equal(provided, expected_from_canonical):
                return FincraVerificationResult(
                    verified=True,
                    # Honest: the signature covered a re-serialisation of the payload, not
                    # the bytes. Everything in {event, data} is still authenticated, so
                    # this is full-body in substance, and `matched_input` is how a caller
                    # tells.
                    strength="full-body",
                    reason=None,
                    matched_input="canonical-reserialisation",
                )

        return FincraVerificationResult(
            verified=False,
            strength="full-body",
            reason=(
                "the signature did not match the raw body, nor a canonical "
                "re-serialisation of {event, data}. Check that you are using the WEBHOOK "
                "secret key rather than the API secret key, and that nothing parsed and "
                "re-serialised the body before it reached here."
            ),
            matched_input=None,
        )


def fincra(**options: Any) -> FincraProvider:
    """Create a Fincra provider."""
    return FincraProvider(**options)


__all__ = ["FincraProvider", "FincraVerificationResult", "fincra"]
