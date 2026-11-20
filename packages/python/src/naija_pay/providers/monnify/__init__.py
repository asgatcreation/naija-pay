"""The Monnify (Moniepoint) adapter.

Read from Monnify's current documentation on 2026-11-11: the OpenAPI 3.1 document at
https://developers.monnify.com/collection/monnify-collection.yml and the webhook guide at
https://developers.monnify.com/docs/webhooks. See ``capabilities.py`` for what is
supported and why, and PROVIDERS.md for the findings.

Six Monnify-specific traps this adapter absorbs, each from the documentation:

1. **Authentication is two calls.** An API key and a secret key go as HTTP Basic to
   ``/api/v1/auth/login``, which returns a Bearer token and an ``expiresIn`` in seconds.
   The token is cached and refreshed a minute early; a 401 clears it and the request is
   retried once with a fresh one, because a token can expire between being read and being
   used.
2. **``requestSuccessful: false`` arrives with HTTP 200.** Monnify signals failure inside
   the envelope as well as with status codes, so the envelope is always checked.
   ``responseCode`` is ``"0"`` on success and ``99`` on failure, and it is a string in
   some responses and a number in others.
3. **``PENDING_AUTHORIZATION`` means no money moved.** Two-factor disbursement is on by
   default, so a created payout normally comes back needing an OTP. Reading
   ``requestSuccessful`` alone would report it as sent. ``create_payout`` surfaces
   ``awaiting_otp``, and ``authorize_payout`` is the second half of the flow.
4. **Decimals on the wire, and strings in the replies.** Amounts go out as decimals in
   major units and come back as strings like ``"100.00"``. Conversion happens here and
   nowhere else, through ``to_major``/``from_major``, which assert the round trip.
5. **Dates are ``dd/MM/yyyy hh:mm:ss a``.** Parsing Monnify's ``paidOn`` as ISO fails
   outright. ``normalise.py`` parses it explicitly.
6. **``restrictPaymentSource`` is never left to the server.** Monnify's documentation
   says it defaults to true, which would mean an account created without an allow-list
   rejects the very inflows you are waiting for. The sandbox returns ``false`` when the
   field is omitted (verified 2026-11-19), so the document and the server disagree. The
   adapter settles it by always sending the field explicitly -- ``true`` exactly when you
   pass ``allowed_sources`` -- so neither default can surprise a caller.

Mirrors ``packages/ts/src/providers/monnify/index.ts``.
"""

from __future__ import annotations

import base64
import os
import sys
import time
from collections.abc import Callable, Mapping, Sequence
from typing import Any

from naija_pay.core.capabilities import assert_supported
from naija_pay.core.errors import (
    AuthenticationError,
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
from naija_pay.core.money import Money, to_major
from naija_pay.core.redact import looks_like_live_key, looks_like_test_key
from naija_pay.core.signatures import SCHEMES, VerificationResult, verify_signature
from naija_pay.providers.monnify.capabilities import (
    CHANNEL_TO_MONNIFY,
    MONNIFY_LIVE_BASE_URL,
    MONNIFY_LOGIN_PATH,
    MONNIFY_PROVIDER_NAME,
    MONNIFY_SANDBOX_BASE_URL,
    MONNIFY_WEBHOOK_IPS,
    NOT_YET_IMPLEMENTED,
    monnify_capabilities,
)
from naija_pay.providers.monnify.normalise import (
    Balance,
    Bank,
    BankAccount,
    BulkPayout,
    Page,
    Payout,
    Refund,
    SplitAccount,
    Transaction,
    VirtualAccount,
    enrich,
    normalise_channel,
    to_balance,
    to_bank,
    to_bulk_payout,
    to_page,
    to_payout,
    to_refund,
    to_split_account,
    to_transaction,
    to_virtual_account,
)

#: How early a token is replaced.
#:
#: Monnify's token lifetime is NOT fixed. The documentation implies an hour, but the
#: sandbox issues ``expiresIn: 828`` -- under fourteen minutes -- so the value returned by
#: the login is the only one to trust, and ``_perform_login`` uses it. This margin is the
#: headroom on top of it: sixty seconds covers a slow request that starts while the token
#: is still valid and arrives after it is not.
_TOKEN_REFRESH_MARGIN_SECONDS = 60.0


def _classify_monnify_error(
    status: int, body: Any
) -> tuple[type[NaijaPayError], str | None] | None:
    """Monnify's error wording, mapped onto our typed errors.

    Monnify's own phrasing, which is its own: it says "Duplicate payment reference" where
    Paystack says "Duplicate transaction reference" and Flutterwave says "reference is
    used already". Each provider matches its own strings rather than sharing one list of
    substrings.
    """
    raw = body.get("responseMessage") if isinstance(body, dict) else None
    message = raw.lower() if isinstance(raw, str) else ""

    if "duplicate" in message or "already exist" in message:
        return (DuplicateReferenceError, None)
    if "insufficient" in message or "balance is not enough" in message:
        return (InsufficientFundsError, None)
    if "invalid credentials" in message or "unauthorized" in message:
        return (AuthenticationError, None)
    if "bvn" in message or "nin" in message or "kyc" in message:
        return (KycRequiredError, None)
    # Monnify gates transfers, sub-accounts and refunds behind commercial approval, and
    # says so in prose. Reported as configuration, not authentication: the key is fine
    # and only Monnify can change it.
    if (
        "not enabled" in message
        or "not activated" in message
        or "contact" in message
        or "not allowed to" in message
    ):
        return (
            ConfigurationError,
            f"monnify: {raw} -- this feature exists but is not enabled on your "
            "integration. Monnify gates transfers, sub-accounts and refunds behind "
            "approval from your relationship manager; the API key is fine.",
        )
    if status == 404 or "not found" in message or "does not exist" in message:
        return (NotFoundError, None)
    if status in (400, 422):
        return (ValidationError, None)
    return None


def _basis_points_to_percentage(basis_points: int, field: str) -> float:
    """Basis points as the percentage Monnify wants.

    2000 basis points is 20, which Monnify reads as 20%. Refused rather than rounded when
    the conversion is not exact, because a rounded split moves somebody's money.
    """
    if not isinstance(basis_points, int) or isinstance(basis_points, bool):
        raise ValidationError(
            f"monnify: {field} must be whole basis points between 0 and 10000 "
            f"(10000 is 100%), not {basis_points!r}.",
            provider=MONNIFY_PROVIDER_NAME,
        )
    if basis_points < 0 or basis_points > 10_000:
        raise ValidationError(
            f"monnify: {field} must be whole basis points between 0 and 10000 "
            f"(10000 is 100%), not {basis_points}.",
            provider=MONNIFY_PROVIDER_NAME,
        )
    return round(basis_points / 100, 2)


def _to_income_split_config(entries: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """Our split entries as Monnify's ``incomeSplitConfig``."""
    out: list[dict[str, Any]] = []
    for entry in entries:
        code = entry.get("sub_account_code")
        share_basis_points = entry.get("share_basis_points")
        share_amount = entry.get("share_amount")
        if share_basis_points is None and share_amount is None:
            raise ValidationError(
                f"monnify: the split entry for {code} needs either share_basis_points or "
                "share_amount.",
                provider=MONNIFY_PROVIDER_NAME,
            )
        item: dict[str, Any] = {"subAccountCode": code}
        if share_basis_points is not None:
            item["splitPercentage"] = _basis_points_to_percentage(
                share_basis_points, "share_basis_points"
            )
        if share_amount is not None:
            item["splitAmount"] = to_major(share_amount)
        if entry.get("fee_basis_points") is not None:
            item["feePercentage"] = _basis_points_to_percentage(
                entry["fee_basis_points"], "fee_basis_points"
            )
        if entry.get("bears_fee") is not None:
            item["feeBearer"] = entry["bears_fee"]
        out.append(item)
    return out


def _is_production_environment() -> bool:
    value = os.environ.get("NODE_ENV") or os.environ.get("ENV") or os.environ.get("ENVIRONMENT")
    return (value or "").lower() == "production"


def _default_live_key_warning(message: str) -> None:
    # Deliberately loud, and on stderr, so it is not lost in normal output.
    print(f"\n*** {message} ***\n", file=sys.stderr)


class MonnifyProvider:
    """Monnify, behind naija-pay's normalised surface."""

    def __init__(
        self,
        *,
        api_key: str,
        secret_key: str,
        contract_code: str | None = None,
        wallet_account_number: str | None = None,
        environment: str | None = None,
        timeout_seconds: float = 30.0,
        retry: RetryPolicy | None = None,
        on_log: Callable[[dict[str, Any]], None] | None = None,
        transport: Transport | None = None,
        sleep: Callable[[float], None] | None = None,
        on_live_key_warning: Callable[[str], None] | None = None,
        now: Callable[[], float] | None = None,
    ) -> None:
        key = (api_key or "").strip()
        secret = (secret_key or "").strip()

        if not key or not secret:
            raise ConfigurationError(
                "monnify: both api_key and secret_key are required. Monnify authenticates "
                "with the pair, as HTTP Basic, and exchanges them for a Bearer token.",
                provider=MONNIFY_PROVIDER_NAME,
            )
        if not key.startswith("MK_"):
            raise ConfigurationError(
                "monnify: api_key must begin MK_TEST_ or MK_PROD_. The secret key is the "
                "longer value next to it on the dashboard, and the two are not "
                "interchangeable.",
                provider=MONNIFY_PROVIDER_NAME,
            )

        declared = environment or ("live" if looks_like_live_key(key) else "test")

        if declared == "test" and looks_like_live_key(key):
            raise ConfigurationError(
                "monnify: a LIVE api key (MK_PROD_) was supplied while environment is "
                "'test'. A live key cannot authenticate against the sandbox host, so this "
                "would fail at Monnify -- but it is refused here, because the mistake it "
                "usually indicates is live credentials in a test deployment.",
                provider=MONNIFY_PROVIDER_NAME,
            )
        if declared == "live" and looks_like_test_key(key):
            raise ConfigurationError(
                "monnify: a TEST api key (MK_TEST_) was supplied while environment is 'live'.",
                provider=MONNIFY_PROVIDER_NAME,
            )
        if declared == "live" and not _is_production_environment():
            warn = on_live_key_warning or _default_live_key_warning
            warn(
                "monnify: using a LIVE api key outside a production environment. "
                "Real money will move."
            )

        self.name = MONNIFY_PROVIDER_NAME
        self.capabilities = monnify_capabilities
        self.not_yet_implemented = NOT_YET_IMPLEMENTED
        self._secret_key = secret
        self._contract_code = (contract_code or "").strip() or None
        self._wallet_account_number = (wallet_account_number or "").strip() or None
        self._now = now or time.monotonic
        self._basic = base64.b64encode(f"{key}:{secret}".encode()).decode("ascii")
        self._token: str | None = None
        self._token_expires_at: float = 0.0

        if transport is None:
            # Imported lazily so the adapter can be constructed, and its validation
            # exercised, without httpx present.
            from naija_pay.core.transport import HttpxTransport

            transport = HttpxTransport()

        options = HttpClientOptions(
            provider=MONNIFY_PROVIDER_NAME,
            base_url=MONNIFY_LIVE_BASE_URL if declared == "live" else MONNIFY_SANDBOX_BASE_URL,
            transport=transport,
            authorize=lambda: {"authorization": f"Bearer {self._access_token()}"},
            timeout_seconds=timeout_seconds,
            classify_error=_classify_monnify_error,
        )
        if retry is not None:
            options.retry = retry
        if on_log is not None:
            options.on_log = on_log
        if sleep is not None:
            options.sleep = sleep

        self._http = HttpClient(options)

    # ------------------------------------------------------------ authentication

    def _access_token(self) -> str:
        """The current Bearer token, logging in when there is not one."""
        if self._token is not None and self._token_expires_at > self._now():
            return self._token
        return self._login()

    def _login(self) -> str:
        try:
            response = self._http.request(
                method="POST",
                path=MONNIFY_LOGIN_PATH,
                operation="auth.login",
                # A read of a token. Safe to repeat, and worth retrying: a failed login
                # takes every other call with it.
                safety="safe",
                headers={"authorization": f"Basic {self._basic}"},
                # The login carries Basic itself. Asking `authorize` for a Bearer here
                # would call straight back into the login.
                skip_authorize=True,
            )
        except AuthenticationError as exc:
            # A 401 here is wrong credentials, not an expired token, so say which pair
            # to check rather than passing on the HTTP client's generic message.
            raise AuthenticationError(
                f"monnify: login failed -- {exc.provider_message or str(exc)}. "
                "Check the api_key and secret_key pair, and that both are for this "
                "environment.",
                provider=MONNIFY_PROVIDER_NAME,
                operation="auth.login",
                http_status=exc.http_status,
            ) from exc

        envelope: dict[str, Any] = response.body if isinstance(response.body, dict) else {}
        raw_body = envelope.get("responseBody")
        body: dict[str, Any] = raw_body if isinstance(raw_body, dict) else {}
        token = body.get("accessToken")

        if envelope.get("requestSuccessful") is False or not isinstance(token, str):
            raise AuthenticationError(
                "monnify: login failed -- "
                f"{envelope.get('responseMessage') or 'no access token was returned'}. "
                "Check the api_key and secret_key pair, and that both are for this "
                "environment.",
                provider=MONNIFY_PROVIDER_NAME,
                operation="auth.login",
                http_status=response.status,
            )

        # Monnify documents expiresIn in seconds. A missing or absurd value falls back to
        # ten minutes rather than to never expiring, which would wedge the client.
        expires_in = body.get("expiresIn")
        seconds = (
            float(expires_in)
            if isinstance(expires_in, (int, float))
            and not isinstance(expires_in, bool)
            and expires_in > 0
            else 600.0
        )
        self._token = token
        self._token_expires_at = self._now() + seconds - _TOKEN_REFRESH_MARGIN_SECONDS
        return token

    def clear_token(self) -> None:
        """Drop the cached token.

        Public because a long-lived process that has seen Monnify return 401 may want to
        force a fresh login, and because the test suite uses it.
        """
        self._token = None
        self._token_expires_at = 0.0

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
        reference: str | None = None,
    ) -> tuple[Any, str, str]:
        """Unwrap Monnify's envelope, retrying once on an expired token.

        A 200 carrying ``requestSuccessful: false`` is a real failure and must never be
        returned as data. One retry on a 401 -- and only on a 401, and only for a request
        that is safe to repeat -- covers a token that expired mid-flight.
        """
        assert_supported(self.capabilities, operation)

        try:
            return self._send(
                method=method,
                path=path,
                operation=operation,
                safety=safety,
                body=body,
                query=query,
                reference=reference,
            )
        except AuthenticationError as error:
            if error.http_status != 401 or safety != "safe":
                raise
            # The token is the likeliest cause, and a second attempt with a fresh one is
            # cheap. Never done for a money-moving request: that is the whole point of
            # the safety taxonomy.
            self.clear_token()
            return self._send(
                method=method,
                path=path,
                operation=operation,
                safety=safety,
                body=body,
                query=query,
                reference=reference,
            )

    def _send(
        self,
        *,
        method: str,
        path: str,
        operation: str,
        safety: str,
        body: Any = None,
        query: Mapping[str, Any] | None = None,
        reference: str | None = None,
    ) -> tuple[Any, str, str]:
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
        raw_code = envelope.get("responseCode")
        response_code = "" if raw_code is None else str(raw_code)

        if envelope.get("requestSuccessful") is False:
            classified = _classify_monnify_error(response.status, envelope)
            error_class = classified[0] if classified else error_class_for_status(response.status)
            message = (
                (classified[1] if classified else None)
                or envelope.get("responseMessage")
                or "monnify reported a failure"
            )
            raise error_class(
                message,
                provider=MONNIFY_PROVIDER_NAME,
                operation=operation,
                http_status=response.status,
                provider_message=envelope.get("responseMessage"),
                provider_code=response_code or None,
                request_id=response.request_id,
            )

        # `/api/v1/transactions/search` is the one documented endpoint that returns its
        # payload -- a Spring page -- at the top level instead of inside `responseBody`.
        # Falling back to the whole body only when the envelope is absent entirely keeps
        # a genuine `responseBody: None` from being mistaken for an unwrapped payload.
        if "responseBody" not in envelope and "requestSuccessful" not in envelope:
            data: Any = response.body
        else:
            data = envelope.get("responseBody")

        return data, envelope.get("responseMessage") or "", response_code

    def _require_contract_code(self, operation: str) -> str:
        if self._contract_code is None:
            raise ConfigurationError(
                "monnify: contract_code is required for this call. It is on the dashboard "
                "under your contract, and every collection endpoint needs it.",
                provider=MONNIFY_PROVIDER_NAME,
                operation=operation,
            )
        return self._contract_code

    def _require_wallet_account_number(self, operation: str) -> str:
        if self._wallet_account_number is None:
            raise ConfigurationError(
                "monnify: wallet_account_number is required for this call. Monnify "
                "disburses from a named wallet account and will not infer one, and the "
                "same number is needed to read the balance.",
                provider=MONNIFY_PROVIDER_NAME,
                operation=operation,
            )
        return self._wallet_account_number

    def _assert_naira(self, amount: Money, operation: str) -> None:
        """NGN only, and failing locally beats a Monnify rejection with no field named."""
        if amount.currency != "NGN":
            raise ValidationError(
                f"monnify: {amount.currency} is not supported. Monnify is a Nigerian "
                "acquirer and its documentation names no currency other than NGN.",
                provider=MONNIFY_PROVIDER_NAME,
                operation=operation,
            )

    def _monnify_channels(self, channels: Sequence[str] | None, operation: str) -> list[str] | None:
        """Our channel names as Monnify's, refusing the ones it does not have."""
        if channels is None:
            return None
        unsupported = [c for c in channels if c not in CHANNEL_TO_MONNIFY]
        if unsupported:
            raise ValidationError(
                f"monnify does not support the channel(s): {', '.join(unsupported)}. "
                "See the capability matrix in PROVIDERS.md.",
                provider=MONNIFY_PROVIDER_NAME,
                operation=operation,
            )
        return [CHANNEL_TO_MONNIFY[c] for c in channels]

    # --------------------------------------------------------------- collections

    def create_checkout(
        self,
        *,
        amount: Money,
        email: str,
        reference: str,
        name: str | None = None,
        description: str | None = None,
        channels: Sequence[str] | None = None,
        callback_url: str | None = None,
        metadata: Mapping[str, Any] | None = None,
        splits: Sequence[Mapping[str, Any]] | None = None,
        contract_code: str | None = None,
    ) -> dict[str, Any]:
        """Create a hosted checkout and return its link.

        ``paymentReference`` is yours and must be unique; Monnify rejects a repeat with
        "Duplicate payment reference", which arrives as ``DuplicateReferenceError``.
        """
        assert_supported(self.capabilities, "checkout.create")
        self._assert_naira(amount, "checkout.create")
        code = contract_code or self._require_contract_code("checkout.create")
        payment_methods = self._monnify_channels(channels, "checkout.create")

        payload: dict[str, Any] = {
            # Decimal major units, converted and round-trip-checked. Never amount.amount.
            "amount": to_major(amount),
            "customerEmail": email,
            "paymentReference": reference,
            "currencyCode": amount.currency,
            "contractCode": code,
        }
        if name is not None:
            payload["customerName"] = name
        if description is not None:
            payload["paymentDescription"] = description
        if callback_url is not None:
            payload["redirectUrl"] = callback_url
        if payment_methods is not None:
            payload["paymentMethods"] = payment_methods
        if splits:
            payload["incomeSplitConfig"] = _to_income_split_config(splits)
        if metadata is not None:
            payload["metaData"] = dict(metadata)

        data, _message, _code = self._call(
            method="POST",
            path="/api/v1/merchant/transactions/init-transaction",
            operation="checkout.create",
            # Keyed on paymentReference: a replay returns the same transaction rather
            # than creating a second one, so this is safe to retry.
            safety="safe",
            body=payload,
        )

        bag = data if isinstance(data, dict) else {}
        enabled_raw = bag.get("enabledPaymentMethod")
        enabled = [
            channel
            for channel in (
                normalise_channel(method)
                for method in (enabled_raw if isinstance(enabled_raw, list) else [])
            )
            if channel is not None
        ]

        return {
            "reference": reference,
            "provider_reference": bag.get("transactionReference") or "",
            "checkout_url": bag.get("checkoutUrl") or "",
            "enabled_channels": tuple(enabled),
            "provider": MONNIFY_PROVIDER_NAME,
            "raw": data,
        }

    def verify_transaction(self, transaction_reference: str) -> Transaction:
        """Verify a transaction by Monnify's own ``transactionReference``.

        The reference contains pipes (``MNFY|67|20220725111957|000283``) and so must be
        percent-encoded into the path. Monnify's own examples show it unencoded, which
        works by luck rather than by design.
        """
        from urllib.parse import quote

        data, _message, _code = self._call(
            method="GET",
            path=f"/api/v2/transactions/{quote(transaction_reference, safe='')}",
            operation="transactions.verify",
            safety="safe",
        )
        return to_transaction(data)

    def verify_transaction_by_reference(self, payment_reference: str) -> Transaction:
        """Verify a transaction by your own ``paymentReference``.

        This is a separate endpoint -- ``/api/v2/merchant/transactions/query`` -- and not
        the search route: it returns the same full transaction payload as
        ``verify_transaction``, so a reference you generated is as good as Monnify's own.
        A reference Monnify has never seen is a 404, which surfaces as ``NotFoundError``.
        """
        data, _message, _code = self._call(
            method="GET",
            path="/api/v2/merchant/transactions/query",
            operation="transactions.verify",
            safety="safe",
            query={"paymentReference": payment_reference},
        )
        if data is None:
            raise NotFoundError(
                f'monnify: no transaction matches the payment reference "{payment_reference}".',
                provider=MONNIFY_PROVIDER_NAME,
                operation="transactions.verify",
            )
        return to_transaction(data)

    def list_transactions(
        self,
        *,
        page: int | None = None,
        page_size: int | None = None,
        payment_reference: str | None = None,
    ) -> Page[Transaction]:
        """List transactions. Monnify pages from zero, which ``to_page`` keeps as-is."""
        query: dict[str, Any] = {}
        if page is not None:
            query["page"] = page
        if page_size is not None:
            query["size"] = page_size
        if payment_reference is not None:
            query["paymentReference"] = payment_reference

        data, _message, _code = self._call(
            method="GET",
            path="/api/v1/transactions/search",
            operation="transactions.list",
            safety="safe",
            query=query,
        )
        # This endpoint returns the Spring page at the top level rather than inside
        # responseBody, which is the one place Monnify breaks its own envelope.
        return to_page(data, to_transaction)

    # ------------------------------------------------------------------- refunds

    def create_refund(
        self,
        *,
        transaction_reference: str,
        amount: Money,
        reference: str,
        reason: str,
        customer_note: str,
        destination_account_number: str | None = None,
        destination_bank_code: str | None = None,
    ) -> Refund:
        """Initiate a refund.

        Needs Monnify's approval in live mode. ``refundReason`` and ``customerNote`` are
        both required by the API; the note is shown to the customer.
        """
        self._assert_naira(amount, "refunds.create")
        payload: dict[str, Any] = {
            "transactionReference": transaction_reference,
            "refundAmount": to_major(amount),
            "refundReference": reference,
            "refundReason": reason,
            "customerNote": customer_note,
        }
        if destination_account_number is not None:
            payload["destinationAccountNumber"] = destination_account_number
        if destination_bank_code is not None:
            payload["destinationAccountBankCode"] = destination_bank_code

        data, _message, _code = self._call(
            method="POST",
            path="/api/v1/refunds/initiate-refund",
            operation="refunds.create",
            # Moves money back to a customer. Never retried.
            safety="money-moving",
            reference=reference,
            body=payload,
        )
        return to_refund(data)

    def get_refund(self, refund_reference: str) -> Refund:
        """One refund's status, by your own refund reference.

        The path is ``/api/v1/refunds/{refundReference}``. Monnify's OpenAPI document
        spells that path key with a literal example value in it --
        ``/api/v1/refunds/202100op3456`` -- and only the ``refundReference`` path
        parameter underneath reveals what it really is. Copying the key would 404 on
        every refund but one. See PROVIDERS.md.
        """
        from urllib.parse import quote

        data, _message, _code = self._call(
            method="GET",
            path=f"/api/v1/refunds/{quote(refund_reference, safe='')}",
            operation="refunds.status",
            safety="safe",
        )
        return to_refund(data)

    def list_refunds(
        self, *, page: int | None = None, page_size: int | None = None
    ) -> Page[Refund]:
        query: dict[str, Any] = {}
        if page is not None:
            query["page"] = page
        if page_size is not None:
            query["size"] = page_size

        data, _message, _code = self._call(
            method="GET",
            path="/api/v1/refunds",
            operation="refunds.status",
            safety="safe",
            query=query,
        )
        return to_page(data, to_refund)

    # ---------------------------------------------------------- virtual accounts

    def create_virtual_account(
        self,
        *,
        reference: str,
        account_name: str,
        customer_email: str,
        customer_name: str,
        bvn: str | None = None,
        nin: str | None = None,
        all_banks: bool | None = None,
        preferred_bank_codes: Sequence[str] | None = None,
        splits: Sequence[Mapping[str, Any]] | None = None,
        allowed_sources: Mapping[str, Any] | None = None,
        contract_code: str | None = None,
    ) -> VirtualAccount:
        """Reserve a virtual account for a customer.

        Two Monnify behaviours worth knowing before you call this:

        - ``all_banks=True`` reserves an account at **every** partner bank at once and
          returns them all. No other Tier 1 provider does this, and it is the reason
          ``accounts`` is a list.
        - ``restrictPaymentSource`` decides whether the account accepts inflows only
          from named sources. Monnify's documentation says it defaults to **true**; the
          sandbox returns **false** when the field is omitted (verified 2026-11-19).
          Rather than depend on either, this adapter always sends the field: ``false``
          unless you pass ``allowed_sources``, so an account you create is usable by
          default.
        """
        assert_supported(self.capabilities, "virtualAccounts.createStatic")
        code = contract_code or self._require_contract_code("virtualAccounts.createStatic")

        if bvn is None and nin is None:
            raise KycRequiredError(
                "monnify: a reserved account needs a bvn (the spec marks it required) or, "
                "where your integration is configured for it, a nin. Neither was supplied.",
                provider=MONNIFY_PROVIDER_NAME,
                operation="virtualAccounts.createStatic",
                required=["bvn"],
            )

        use_all_banks = all_banks if all_banks is not None else preferred_bank_codes is None
        if not use_all_banks and not preferred_bank_codes:
            raise ValidationError(
                "monnify: either set all_banks, or name at least one preferred_bank_codes "
                "entry. Monnify requires one or the other and rejects a request with "
                "neither.",
                provider=MONNIFY_PROVIDER_NAME,
                operation="virtualAccounts.createStatic",
            )

        payload: dict[str, Any] = {
            "accountReference": reference,
            "accountName": account_name,
            "currencyCode": "NGN",
            "contractCode": code,
            "customerEmail": customer_email,
            "customerName": customer_name,
            "getAllAvailableBanks": use_all_banks,
            # Explicitly false rather than omitted: Monnify's own default is true.
            "restrictPaymentSource": allowed_sources is not None,
        }
        if bvn is not None:
            payload["bvn"] = bvn
        if nin is not None:
            payload["nin"] = nin
        if not use_all_banks:
            payload["preferredBanks"] = list(preferred_bank_codes or ())
        if splits:
            payload["incomeSplitConfig"] = _to_income_split_config(splits)
        if allowed_sources is not None:
            sources: dict[str, Any] = {}
            if allowed_sources.get("bvns") is not None:
                sources["bvns"] = list(allowed_sources["bvns"])
            if allowed_sources.get("account_names") is not None:
                sources["accountNames"] = list(allowed_sources["account_names"])
            if allowed_sources.get("bank_accounts") is not None:
                sources["bankAccounts"] = [dict(a) for a in allowed_sources["bank_accounts"]]
            payload["allowedPaymentSources"] = sources

        data, _message, _code = self._call(
            method="POST",
            path="/api/v2/bank-transfer/reserved-accounts",
            operation="virtualAccounts.createStatic",
            # Keyed on accountReference. A replay returns the existing reservation.
            safety="safe",
            body=payload,
        )
        return to_virtual_account(data, reference=reference, kind="static")

    def get_virtual_account(self, reference: str) -> VirtualAccount:
        from urllib.parse import quote

        data, _message, _code = self._call(
            method="GET",
            path=f"/api/v2/bank-transfer/reserved-accounts/{quote(reference, safe='')}",
            operation="virtualAccounts.get",
            safety="safe",
        )
        return to_virtual_account(data, reference=reference, kind="static")

    def update_virtual_account_bvn(self, *, reference: str, bvn: str) -> VirtualAccount:
        """Update the BVN on a reserved account.

        Monnify has two KYC routes and they are not interchangeable: this one takes a BVN
        alone, and ``update_virtual_account_kyc`` requires both a BVN and a NIN. Note also
        that this route's path parameter is named ``reservedAccountReference`` while every
        neighbouring route calls the same value ``accountReference``.
        """
        from urllib.parse import quote

        data, _message, _code = self._call(
            method="PUT",
            path=(
                "/api/v1/bank-transfer/reserved-accounts/update-customer-bvn/"
                f"{quote(reference, safe='')}"
            ),
            operation="virtualAccounts.updateKyc",
            safety="safe",
            body={"bvn": bvn},
        )
        return to_virtual_account(data, reference=reference, kind="static")

    def update_virtual_account_kyc(self, *, reference: str, bvn: str, nin: str) -> VirtualAccount:
        """Attach both a BVN and a NIN to a reserved account.

        Monnify's spec marks **both** fields required on this route, so a caller with only
        one of them is told locally to use ``update_virtual_account_bvn`` instead of
        receiving a rejection that does not name the field.
        """
        from urllib.parse import quote

        if not bvn or not nin:
            raise ValidationError(
                "monnify: the kyc-info route requires BOTH a bvn and a nin. To set a BVN "
                "alone, use update_virtual_account_bvn, which is a different endpoint.",
                provider=MONNIFY_PROVIDER_NAME,
                operation="virtualAccounts.updateKyc",
            )

        data, _message, _code = self._call(
            method="PUT",
            path=(f"/api/v1/bank-transfer/reserved-accounts/{quote(reference, safe='')}/kyc-info"),
            operation="virtualAccounts.updateKyc",
            safety="safe",
            body={"bvn": bvn, "nin": nin},
        )
        return to_virtual_account(data, reference=reference, kind="static")

    def update_virtual_account_splits(
        self, *, reference: str, splits: Sequence[Mapping[str, Any]]
    ) -> Any:
        """Replace a reserved account's income split configuration.

        The request body is a bare **array**, not an object -- the one endpoint in the
        Monnify API where that is true.
        """
        from urllib.parse import quote

        data, _message, _code = self._call(
            method="PUT",
            path=(
                "/api/v1/bank-transfer/reserved-accounts/update-income-split-config/"
                f"{quote(reference, safe='')}"
            ),
            operation="splits.update",
            safety="safe",
            body=_to_income_split_config(splits),
        )
        return data

    def deactivate_virtual_account(self, reference: str) -> VirtualAccount:
        """Deallocate a reserved account.

        Monnify's word is deallocation and there is no route to undo it, so the account
        number is gone for good. Flutterwave, by contrast, deactivates and reactivates one
        account; this is why ``virtualAccounts.deactivate`` is where Monnify's support
        ends.
        """
        from urllib.parse import quote

        data, _message, _code = self._call(
            method="DELETE",
            path=(f"/api/v1/bank-transfer/reserved-accounts/reference/{quote(reference, safe='')}"),
            operation="virtualAccounts.deactivate",
            # Not money-moving, but it destroys state and is not keyed by anything we own,
            # so it is never retried.
            safety="unsafe",
            reference=reference,
        )
        return to_virtual_account(data, reference=reference, kind="static")

    def list_virtual_account_inflows(
        self, *, reference: str, page: int | None = None, page_size: int | None = None
    ) -> Page[Transaction]:
        """Inflows to one reserved account. ``accountReference`` is required by Monnify."""
        query: dict[str, Any] = {"accountReference": reference}
        if page is not None:
            query["page"] = page
        if page_size is not None:
            query["size"] = page_size

        data, _message, _code = self._call(
            method="GET",
            path="/api/v1/bank-transfer/reserved-accounts/transactions",
            operation="virtualAccounts.listInflows",
            safety="safe",
            query=query,
        )
        return to_page(data, to_transaction)

    # ------------------------------------------------------------ split accounts

    def create_split_accounts(
        self, accounts: Sequence[Mapping[str, Any]]
    ) -> tuple[SplitAccount, ...]:
        """Create one or more settlement sub-accounts.

        Monnify takes an array here and returns an array, even for a single sub-account,
        which is why this method is plural. Needs Monnify's approval in live mode.
        """
        if not accounts:
            raise ValidationError(
                "monnify: create_split_accounts needs at least one account.",
                provider=MONNIFY_PROVIDER_NAME,
                operation="splitAccounts.create",
            )

        data, _message, _code = self._call(
            method="POST",
            path="/api/v1/sub-accounts",
            operation="splitAccounts.create",
            # Creates state with no reference of ours to key on, so a repeat would make a
            # second sub-account.
            safety="unsafe",
            body=[
                {
                    "currencyCode": account.get("currency_code") or "NGN",
                    "accountNumber": account["account_number"],
                    "bankCode": account["bank_code"],
                    "email": account["email"],
                    "defaultSplitPercentage": _basis_points_to_percentage(
                        account["default_share_basis_points"], "default_share_basis_points"
                    ),
                }
                for account in accounts
            ],
        )
        return tuple(to_split_account(item) for item in (data if isinstance(data, list) else []))

    def list_split_accounts(self) -> tuple[SplitAccount, ...]:
        data, _message, _code = self._call(
            method="GET",
            path="/api/v1/sub-accounts",
            operation="splitAccounts.list",
            safety="safe",
        )
        return tuple(to_split_account(item) for item in (data if isinstance(data, list) else []))

    def update_split_account(
        self,
        *,
        sub_account_code: str,
        account_number: str,
        bank_code: str,
        email: str,
        default_share_basis_points: int,
        currency_code: str = "NGN",
    ) -> SplitAccount:
        """Update a sub-account. ``subAccountCode`` goes in the body, not the path."""
        data, _message, _code = self._call(
            method="PUT",
            path="/api/v1/sub-accounts",
            operation="splitAccounts.update",
            safety="safe",
            body={
                "subAccountCode": sub_account_code,
                "currencyCode": currency_code,
                "accountNumber": account_number,
                "bankCode": bank_code,
                "email": email,
                "defaultSplitPercentage": _basis_points_to_percentage(
                    default_share_basis_points, "default_share_basis_points"
                ),
            },
        )
        return to_split_account(data)

    def delete_split_account(self, sub_account_code: str) -> None:
        from urllib.parse import quote

        self._call(
            method="DELETE",
            path=f"/api/v1/sub-accounts/{quote(sub_account_code, safe='')}",
            operation="splitAccounts.deactivate",
            safety="unsafe",
            reference=sub_account_code,
        )

    def create_split(self, entries: Sequence[Mapping[str, Any]]) -> tuple[Mapping[str, Any], ...]:
        """A reusable split declaration.

        Monnify has no split object to create, so this makes no network call: it validates
        the shares and returns the entries to hand to ``create_checkout`` or
        ``create_virtual_account``.
        """
        assert_supported(self.capabilities, "splits.create")
        # Converted and thrown away, purely so an invalid share fails here rather than on
        # the checkout call that uses it days later.
        _to_income_split_config(entries)
        return tuple(entries)

    # ------------------------------------------------------------------- payouts

    def create_payout(
        self,
        *,
        amount: Money,
        reference: str,
        narration: str,
        bank_code: str,
        account_number: str,
        account_name: str,
        source_account_number: str | None = None,
        is_async: bool | None = None,
    ) -> Payout:
        """Create a single transfer.

        **This usually does not move money yet.** Monnify enables two-factor disbursement
        by default, and a new transfer then comes back with status
        ``PENDING_AUTHORIZATION``: an OTP goes to the registered email, and nothing happens
        until ``authorize_payout`` submits it. The returned payout carries ``awaiting_otp``
        so a caller can act on that rather than waiting for a webhook that will never
        arrive.

        Never retried, whatever the transport does. A duplicate transfer is the most
        expensive bug this SDK could have, so a timeout raises ``PayoutStatusUnknownError``
        naming your reference to query.
        """
        self._assert_naira(amount, "payouts.create")
        source = source_account_number or self._require_wallet_account_number("payouts.create")

        payload: dict[str, Any] = {
            "amount": to_major(amount),
            "reference": reference,
            "narration": narration,
            "destinationBankCode": bank_code,
            "destinationAccountNumber": account_number,
            "destinationAccountName": account_name,
            "currency": amount.currency,
            "sourceAccountNumber": source,
        }
        if is_async is not None:
            payload["async"] = is_async

        data, _message, _code = self._call(
            method="POST",
            path="/api/v2/disbursements/single",
            operation="payouts.create",
            safety="money-moving",
            reference=reference,
            body=payload,
        )
        return to_payout(data)

    def authorize_payout(self, *, reference: str, otp: str) -> Payout:
        """Submit the OTP for a single transfer.

        The second half of ``create_payout`` whenever two-factor is on. Money-moving: this
        is the call that actually releases the funds.
        """
        data, _message, _code = self._call(
            method="POST",
            path="/api/v2/disbursements/single/validate-otp",
            operation="payouts.create",
            safety="money-moving",
            reference=reference,
            body={"reference": reference, "authorizationCode": otp},
        )
        return to_payout(data)

    def resend_payout_otp(self, reference: str) -> str:
        """Ask Monnify to send a fresh OTP for a transfer awaiting authorisation."""
        data, message, _code = self._call(
            method="POST",
            path="/api/v2/disbursements/single/resend-otp",
            operation="payouts.create",
            # Sends an email. Nothing moves, and a repeat is harmless.
            safety="safe",
            body={"reference": reference},
        )
        bag = data if isinstance(data, dict) else {}
        return bag.get("message") or message

    def get_payout(self, reference: str) -> Payout:
        """One transfer's status, by your own reference."""
        data, _message, _code = self._call(
            method="GET",
            path="/api/v2/disbursements/single/summary",
            operation="payouts.status",
            safety="safe",
            query={"reference": reference},
        )
        return to_payout(data)

    def list_payouts(
        self, *, page: int | None = None, page_size: int | None = None
    ) -> Page[Payout]:
        query: dict[str, Any] = {}
        # This endpoint spells its paging parameters pageNo and pageSize, where the
        # transaction search uses page and size. Monnify is not consistent, and guessing
        # wrong silently returns the first page every time.
        if page is not None:
            query["pageNo"] = page
        if page_size is not None:
            query["pageSize"] = page_size

        data, _message, _code = self._call(
            method="GET",
            path="/api/v2/disbursements/single/transactions",
            operation="payouts.status",
            safety="safe",
            query=query,
        )
        return to_page(data, to_payout)

    def create_bulk_payout(
        self,
        *,
        batch_reference: str,
        narration: str,
        transfers: Sequence[Mapping[str, Any]],
        source_account_number: str | None = None,
        on_validation_failure: str = "BREAK",
        notification_interval: int = 10,
    ) -> BulkPayout:
        """Create a batch of transfers.

        ``on_validation_failure`` decides what happens to a batch containing one bad row:
        ``BREAK`` abandons the whole batch, ``CONTINUE`` skips the row. Defaulted to
        ``BREAK``, because the safe default for money is to do nothing until a human looks.
        """
        if not transfers:
            raise ValidationError(
                "monnify: a bulk payout needs at least one transfer.",
                provider=MONNIFY_PROVIDER_NAME,
                operation="payouts.createBulk",
            )
        for transfer in transfers:
            self._assert_naira(transfer["amount"], "payouts.createBulk")
        source = source_account_number or self._require_wallet_account_number("payouts.createBulk")

        rows: list[dict[str, Any]] = []
        for transfer in transfers:
            row: dict[str, Any] = {
                "amount": to_major(transfer["amount"]),
                "reference": transfer["reference"],
                "narration": transfer["narration"],
                "destinationBankCode": transfer["bank_code"],
                "destinationAccountNumber": transfer["account_number"],
                "currency": transfer["amount"].currency,
            }
            if transfer.get("account_name") is not None:
                row["destinationAccountName"] = transfer["account_name"]
            rows.append(row)

        data, _message, _code = self._call(
            method="POST",
            path="/api/v2/disbursements/batch",
            operation="payouts.createBulk",
            safety="money-moving",
            reference=batch_reference,
            body={
                "title": narration,
                "batchReference": batch_reference,
                "narration": narration,
                "sourceAccountNumber": source,
                "onValidationFailure": on_validation_failure,
                "notificationInterval": notification_interval,
                "transactionList": rows,
            },
        )
        return to_bulk_payout(data)

    def authorize_bulk_payout(self, *, batch_reference: str, otp: str) -> BulkPayout:
        """Submit the OTP for a batch. The field is ``reference``, not ``batchReference``."""
        data, _message, _code = self._call(
            method="POST",
            path="/api/v2/disbursements/batch/validate-otp",
            operation="payouts.createBulk",
            safety="money-moving",
            reference=batch_reference,
            body={"reference": batch_reference, "authorizationCode": otp},
        )
        return to_bulk_payout(data)

    def get_bulk_payout(self, batch_reference: str) -> BulkPayout:
        """A batch's summary, including per-status counts and amounts."""
        data, _message, _code = self._call(
            method="GET",
            path="/api/v2/disbursements/batch/summary",
            operation="payouts.status",
            safety="safe",
            # This endpoint takes the batch reference as `reference`.
            query={"reference": batch_reference},
        )
        return to_bulk_payout(data)

    # --------------------------------------------------------- banks and balance

    def list_banks(self) -> tuple[Bank, ...]:
        """Every bank Monnify can pay, with its USSD templates."""
        data, _message, _code = self._call(
            method="GET",
            path="/api/v1/banks",
            operation="banks.list",
            safety="safe",
        )
        return tuple(to_bank(item) for item in (data if isinstance(data, list) else []))

    def resolve_account(self, *, account_number: str, bank_code: str) -> BankAccount:
        """Resolve an account number to its holder's name.

        Monnify echoes the bank code back, which Flutterwave does not, so no carrying
        through is needed here.
        """
        data, _message, _code = self._call(
            method="GET",
            path="/api/v2/disbursements/account/validate",
            operation="banks.resolveAccount",
            safety="safe",
            query={"accountNumber": account_number, "bankCode": bank_code},
        )
        bag = data if isinstance(data, dict) else {}
        return enrich(
            account_number=bag.get("accountNumber") or account_number,
            account_name=bag.get("accountName") or "",
            bank_code=bag.get("bankCode") or bank_code,
        )

    def get_balance(self, account_number: str | None = None) -> Balance:
        """Your wallet balance, as integer minor units."""
        account = account_number or self._require_wallet_account_number("balance.get")
        data, _message, _code = self._call(
            method="GET",
            path="/api/v2/disbursements/wallet-balance",
            operation="balance.get",
            safety="safe",
            query={"accountNumber": account},
        )
        return to_balance(data, account)

    # ------------------------------------------------------------------ webhooks

    def verify_webhook(self, *, body: bytes, headers: Mapping[str, str]) -> VerificationResult:
        """Verify a webhook from Monnify.

        ``body`` must be the raw bytes exactly as received. Parsing or re-serialising
        first guarantees a mismatch, and it is the commonest cause of "my signature does
        not verify".

        HMAC-SHA512 hex over the raw body, keyed with your **secret key** -- Monnify calls
        it the client secret, and it is the same value used to authenticate, not a separate
        webhook key.

        **In sandbox there is nothing to verify.** Monnify's documentation says the
        ``monnify-signature`` header is only included on production notifications, so a
        sandbox delivery returns ``verified=False`` with that as the reason. That is the
        honest answer, and it is why this adapter also offers ``is_known_webhook_ip``.
        """
        assert_supported(self.capabilities, "webhooks.verify")

        lowered = {key.lower(): value for key, value in headers.items()}
        if "monnify-signature" not in lowered:
            return VerificationResult(
                verified=False,
                strength="unverified",
                reason=(
                    'the "monnify-signature" header is missing. Monnify documents that '
                    "this header is only sent on production notifications and is absent "
                    "in sandbox, so a sandbox delivery can never be verified -- check the "
                    "source IP against is_known_webhook_ip and re-verify the transaction "
                    "with the API before giving value."
                ),
            )

        return verify_signature(
            scheme=SCHEMES["monnify"],
            body=body,
            headers=lowered,
            secret=self._secret_key,
        )

    def is_known_webhook_ip(self, ip: str) -> bool:
        """Is this the address Monnify sends webhooks from?

        Monnify publishes one: ``35.242.133.146``. A second line of defence, never a
        replacement for the signature -- an IP is trivially spoofed if anything between
        Monnify and your handler is willing to forward a header.
        """
        return ip.strip() in MONNIFY_WEBHOOK_IPS


def monnify(**options: Any) -> MonnifyProvider:
    """Create a Monnify provider."""
    return MonnifyProvider(**options)


__all__ = ["MonnifyProvider", "monnify"]
