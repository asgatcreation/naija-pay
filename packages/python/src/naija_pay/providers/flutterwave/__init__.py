"""The Flutterwave adapter.

Read from Flutterwave's current documentation on 2026-11-02. Not yet sandbox-verified;
see PROVIDERS.md for the status table.

Why this talks to v3 rather than v4 is explained in ``capabilities.py``. Five
Flutterwave-specific traps this adapter absorbs, each from the docs:

1. **Decimals on the wire.** Every amount Flutterwave sends or accepts is a decimal in
   major units -- ``5000`` means five thousand naira, and a balance comes back as
   ``20000.5``. naija-pay is integer minor units throughout, so conversion happens at
   this boundary and nowhere else, through ``to_major``/``from_major``, which assert the
   round trip instead of multiplying by 100 and hoping.
2. **"Transfer Queued Successfully" is not a completed transfer.** A created payout comes
   back with the envelope saying ``"status": "success"`` and ``data.status`` saying
   ``"NEW"``. It is queued. Reading the envelope would mark every payout as paid the
   moment Flutterwave accepted it; we read ``data.status`` and report ``pending``.
3. **A 200 can be a failure.** v3 signals errors with ``"status": "error"`` inside a 200
   response as well as with HTTP statuses, so the envelope is always checked.
4. **Percentage splits are decimal fractions.** Flutterwave's own docs say a 9%
   commission is ``0.09``. Our API is basis points, so 900 becomes 0.09 here.
5. **Two webhook schemes, one weak.** v3's ``verif-hash`` is the secret itself and proves
   nothing about the payload. ``verify_webhook`` reports which scheme it used and how
   strong it was, so an application can refuse the weak one.

Mirrors ``packages/ts/src/providers/flutterwave/index.ts``.
"""

from __future__ import annotations

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
from naija_pay.core.money import Money, basis_points_to_fraction, to_major
from naija_pay.core.redact import looks_like_live_key, looks_like_test_key
from naija_pay.core.signatures import SCHEMES, verify_signature
from naija_pay.providers.flutterwave.capabilities import (
    CHANNEL_TO_FLUTTERWAVE,
    FLUTTERWAVE_BASE_URL,
    FLUTTERWAVE_PROVIDER_NAME,
    NOT_YET_IMPLEMENTED,
    flutterwave_capabilities,
)
from naija_pay.providers.flutterwave.normalise import (
    BankAccount,
    Payout,
    Refund,
    SplitAccount,
    Transaction,
    VirtualAccount,
    WalletAccount,
    WalletBalance,
    enrich,
    to_payout,
    to_refund,
    to_split_account,
    to_transaction,
    to_virtual_account,
    to_wallet_account,
    to_wallet_balance,
)

#: Flutterwave's reference rules.
#:
#: v3 does not publish a pattern for ``tx_ref``, but v4 does -- 6 to 42 characters of
#: letters, digits and hyphens -- and a reference that v4 would reject is a reference that
#: cannot be carried forward when v4 arrives. We enforce the stricter rule now, with a
#: message that says why, rather than accepting something that will break later.
_REFERENCE = re.compile(r"^[A-Za-z0-9-]{6,42}$")


def _classify_flutterwave_error(
    status: int, body: Any
) -> tuple[type[NaijaPayError], str | None] | None:
    """Flutterwave's error wording, mapped onto our typed errors.

    Matched on Flutterwave's own documented phrasing, which differs from Paystack's for
    the same condition: Flutterwave says "Insufficient funds" where Paystack says "Your
    balance is not enough to fulfil this request". That difference was found by running
    against Paystack's sandbox, and it is why each provider matches its own wording
    rather than sharing one list of substrings.
    """
    message = ""
    if isinstance(body, dict) and isinstance(body.get("message"), str):
        message = body["message"].lower()

    if "reference is used already" in message or "duplicate" in message:
        return (DuplicateReferenceError, None)
    if "insufficient" in message:
        return (InsufficientFundsError, None)
    # Flutterwave gates several features per merchant, and says so in prose rather than
    # with a distinct code. Reported as configuration, not authentication, because the
    # key is fine and only support can change it.
    if (
        "not enabled" in message
        or "not activated" in message
        or "kindly contact" in message
        or "contact support" in message
    ):
        raw = body.get("message") if isinstance(body, dict) else ""
        return (
            ConfigurationError,
            f"flutterwave: {raw} -- this feature exists but is not enabled on your "
            "account. Ask Flutterwave support to enable it; the API key is fine.",
        )
    if "bvn" in message or "nin" in message or "kyc" in message:
        return (KycRequiredError, None)
    if status == 404 or "no transaction" in message or "not found" in message:
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


class FlutterwaveProvider:
    """Flutterwave, behind naija-pay's normalised surface."""

    def __init__(
        self,
        *,
        secret_key: str,
        webhook_secret_hash: str | None = None,
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
                "flutterwave: secret_key is required", provider=FLUTTERWAVE_PROVIDER_NAME
            )
        if not key.startswith("FLWSECK"):
            raise ConfigurationError(
                "flutterwave: secret_key must be a v3 secret key beginning FLWSECK_TEST- "
                "or FLWSECK-. A public key (FLWPUBK) cannot authorise server-side calls, "
                "and a v4 OAuth client secret is not a v3 key -- this adapter speaks v3, "
                "for the reasons in PROVIDERS.md.",
                provider=FLUTTERWAVE_PROVIDER_NAME,
            )

        declared = environment or ("live" if looks_like_live_key(key) else "test")

        # The check that matters, because v3 serves test and live from one host.
        if declared == "test" and looks_like_live_key(key):
            raise ConfigurationError(
                "flutterwave: a LIVE secret key was supplied while environment is 'test'. "
                "v3 serves test and live from the same host, so this would move real "
                "money. Use a FLWSECK_TEST- key, or set environment to 'live' deliberately.",
                provider=FLUTTERWAVE_PROVIDER_NAME,
            )
        if declared == "live" and looks_like_test_key(key):
            raise ConfigurationError(
                "flutterwave: a TEST secret key was supplied while environment is 'live'.",
                provider=FLUTTERWAVE_PROVIDER_NAME,
            )

        if declared == "live" and not _is_production_environment():
            warn = on_live_key_warning or _default_live_key_warning
            warn(
                "flutterwave: using a LIVE key outside a production environment. "
                "Real money will move."
            )

        self.name = FLUTTERWAVE_PROVIDER_NAME
        self.capabilities = flutterwave_capabilities
        self.not_yet_implemented = NOT_YET_IMPLEMENTED
        self._webhook_secret_hash = (webhook_secret_hash or "").strip() or None

        if transport is None:
            # Imported lazily so the adapter can be constructed, and its validation
            # exercised, without httpx present.
            from naija_pay.core.transport import HttpxTransport

            transport = HttpxTransport()

        options = HttpClientOptions(
            provider=FLUTTERWAVE_PROVIDER_NAME,
            base_url=FLUTTERWAVE_BASE_URL,
            transport=transport,
            headers={"authorization": f"Bearer {key}"},
            timeout_seconds=timeout_seconds,
            classify_error=_classify_flutterwave_error,
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
        """Unwrap Flutterwave's ``{status, message, data}`` envelope.

        ``status`` is a string here, not Paystack's boolean: ``"success"`` or
        ``"error"``. A 200 carrying ``"status": "error"`` is a real failure and must not
        be returned as data -- Flutterwave uses that combination for duplicate
        references among others.
        """
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
        raw_status = envelope.get("status")
        status = raw_status.lower() if isinstance(raw_status, str) else ""
        if status not in ("", "success"):
            classified = _classify_flutterwave_error(response.status, envelope)
            error_class = classified[0] if classified else error_class_for_status(response.status)
            message = (
                (classified[1] if classified else None)
                or envelope.get("message")
                or "flutterwave reported a failure"
            )
            raise error_class(
                message,
                provider=FLUTTERWAVE_PROVIDER_NAME,
                operation=operation,
                http_status=response.status,
                provider_message=envelope.get("message"),
                request_id=response.request_id,
            )

        return envelope.get("data"), envelope.get("message") or "", envelope.get("meta")

    def _assert_reference(self, reference: str, operation: str) -> None:
        """Reject a reference that v4 would reject, before it is written to anything."""
        if not _REFERENCE.match(reference or ""):
            raise ValidationError(
                f'flutterwave: the reference "{reference}" is not acceptable. Use 6 to 42 '
                "characters of letters, digits and hyphens. v3 accepts more than that, "
                "but v4 enforces this pattern, so a reference outside it cannot be "
                "carried forward when you migrate.",
                provider=FLUTTERWAVE_PROVIDER_NAME,
                operation=operation,
            )

    # ------------------------------------------------------------- collections

    def create_checkout(
        self,
        *,
        amount: Money,
        email: str,
        reference: str,
        name: str | None = None,
        phone: str | None = None,
        channels: Sequence[str] | None = None,
        callback_url: str | None = None,
        metadata: Mapping[str, str] | None = None,
        title: str | None = None,
        logo_url: str | None = None,
        session_duration_minutes: int | None = None,
        subaccounts: Sequence[Mapping[str, Any]] | None = None,
        payment_plan: int | None = None,
    ) -> dict[str, Any]:
        """Create a hosted checkout and return its link.

        This is v3 Standard. v4 has no hosted page at all, which is why collections stay
        on v3: charging a card on v4 means holding the card number, and naija-pay never
        does that.
        """
        assert_supported(self.capabilities, "checkout.create")
        self._assert_reference(reference, "checkout.create")

        flw_channels: list[str] = []
        if channels is not None:
            unsupported = [c for c in channels if c not in CHANNEL_TO_FLUTTERWAVE]
            if unsupported:
                raise ValidationError(
                    f"flutterwave does not support the channel(s): {', '.join(unsupported)}. "
                    "See the capability matrix in PROVIDERS.md.",
                    provider=FLUTTERWAVE_PROVIDER_NAME,
                    operation="checkout.create",
                )
            flw_channels = [CHANNEL_TO_FLUTTERWAVE[c] for c in channels]

        customer: dict[str, Any] = {"email": email}
        if name is not None:
            customer["name"] = name
        if phone is not None:
            customer["phone_number"] = phone

        payload: dict[str, Any] = {
            "tx_ref": reference,
            # Decimal major units, converted and round-trip-checked. Never amount.amount.
            "amount": to_major(amount),
            "currency": amount.currency,
            "customer": customer,
        }
        if callback_url is not None:
            payload["redirect_url"] = callback_url
        if flw_channels:
            # A comma-separated string, not an array. Flutterwave ignores an array here,
            # which silently offers every channel instead of the ones you asked for.
            payload["payment_options"] = ",".join(flw_channels)
        if title is not None or logo_url is not None:
            customizations: dict[str, Any] = {}
            if title is not None:
                customizations["title"] = title
            if logo_url is not None:
                customizations["logo"] = logo_url
            payload["customizations"] = customizations
        if session_duration_minutes is not None:
            payload["configuration"] = {"session_duration": session_duration_minutes}
        if subaccounts:
            payload["subaccounts"] = [dict(entry) for entry in subaccounts]
        if payment_plan is not None:
            payload["payment_plan"] = payment_plan
        if metadata is not None:
            payload["meta"] = dict(metadata)

        data, _message, _meta = self._call(
            method="POST",
            path="/payments",
            operation="checkout.create",
            # Safe to retry: Flutterwave keys off tx_ref, so a replay returns a link for
            # the same transaction rather than creating a second one.
            safety="safe",
            body=payload,
        )
        bag = data if isinstance(data, dict) else {}
        return {
            "reference": reference,
            "checkout_url": bag.get("link"),
            "provider": FLUTTERWAVE_PROVIDER_NAME,
            "raw": data,
        }

    def verify_transaction(self, transaction_id: str | int) -> Transaction:
        """Verify a transaction by Flutterwave's numeric id.

        The id comes from the webhook or from ``list_transactions``. If all you have is
        your own reference, use ``verify_transaction_by_reference``.
        """
        data, _message, _meta = self._call(
            method="GET",
            path=f"/transactions/{transaction_id}/verify",
            operation="transactions.verify",
            safety="safe",
        )
        return to_transaction(data)

    def verify_transaction_by_reference(self, reference: str) -> Transaction:
        """Verify by the ``tx_ref`` you chose, which is usually what an application holds."""
        data, _message, _meta = self._call(
            method="GET",
            path="/transactions/verify_by_reference",
            operation="transactions.verify",
            safety="safe",
            query={"tx_ref": reference},
        )
        return to_transaction(data)

    def list_transactions(
        self,
        *,
        page: int | None = None,
        from_date: str | None = None,
        to_date: str | None = None,
        currency: str | None = None,
        status: str | None = None,
        customer_email: str | None = None,
    ) -> tuple[tuple[Transaction, ...], Any]:
        data, _message, meta = self._call(
            method="GET",
            path="/transactions",
            operation="transactions.list",
            safety="safe",
            query={
                "page": page,
                "from": from_date,
                "to": to_date,
                "currency": currency,
                "status": status,
                "customer_email": customer_email,
            },
        )
        items = data if isinstance(data, list) else []
        return tuple(to_transaction(item) for item in items), meta

    def create_refund(self, *, transaction_id: str | int, amount: Money | None = None) -> Refund:
        """Refund a transaction, fully or partially."""
        data, _message, _meta = self._call(
            method="POST",
            path=f"/transactions/{transaction_id}/refund",
            operation="refunds.create",
            # Never retried: a replayed refund could refund twice. Flutterwave v3 has no
            # idempotency key -- that is a v4 feature -- so nothing makes this safe.
            safety="money-moving",
            reference=str(transaction_id),
            body={} if amount is None else {"amount": to_major(amount)},
        )
        return to_refund(data)

    def list_refunds(self, transaction_id: str | int) -> tuple[Refund, ...]:
        """Refunds recorded against a transaction, as Flutterwave returns them."""
        data, _message, _meta = self._call(
            method="GET",
            path="/transactions/refunds",
            operation="refunds.status",
            safety="safe",
            query={"id": str(transaction_id)},
        )
        items = data if isinstance(data, list) else []
        return tuple(to_refund(item) for item in items)

    # -------------------------------------------------------- virtual accounts

    def create_static_virtual_account(
        self,
        *,
        email: str,
        reference: str,
        bvn: str | None = None,
        nin: str | None = None,
        first_name: str | None = None,
        last_name: str | None = None,
        phone: str | None = None,
        narration: str | None = None,
        bank_code: str | None = None,
    ) -> VirtualAccount:
        """Create a static (permanent) virtual account for a customer.

        CBN rules mean a permanent NGN account needs a BVN or a NIN; Flutterwave accepts
        either. We fail locally with that message rather than relaying an opaque
        rejection.
        """
        assert_supported(self.capabilities, "virtualAccounts.createStatic")
        self._assert_reference(reference, "virtualAccounts.createStatic")

        if not bvn and not nin:
            raise KycRequiredError(
                "flutterwave: a BVN or a NIN is required for a permanent virtual account "
                "under CBN rules. Flutterwave accepts either.",
                provider=FLUTTERWAVE_PROVIDER_NAME,
                operation="virtualAccounts.createStatic",
                required=["bvn"],
            )

        payload: dict[str, Any] = {
            "email": email,
            "is_permanent": True,
            "tx_ref": reference,
        }
        if bvn is not None:
            payload["bvn"] = bvn
        if nin is not None:
            payload["nin"] = nin
        if first_name is not None:
            payload["firstname"] = first_name
        if last_name is not None:
            payload["lastname"] = last_name
        if phone is not None:
            payload["phonenumber"] = phone
        if narration is not None:
            payload["narration"] = narration
        if bank_code is not None:
            payload["bank_code"] = bank_code

        data, _message, _meta = self._call(
            method="POST",
            path="/virtual-account-numbers",
            operation="virtualAccounts.createStatic",
            safety="safe",
            body=payload,
        )
        return to_virtual_account(data, reference=reference, kind="static")

    def create_dynamic_virtual_account(
        self,
        *,
        email: str,
        reference: str,
        amount: Money,
        expires_in_seconds: int | None = None,
        narration: str | None = None,
        bank_code: str | None = None,
    ) -> VirtualAccount:
        """Create a dynamic virtual account that expires.

        Flutterwave does offer this, which Paystack does not: a per-transaction account
        for a fixed amount. ``expires_in_seconds`` is left unset by default so
        Flutterwave's own 60-second default applies -- deliberately not lengthened,
        because a longer default would quietly widen the window in which a stale account
        still accepts money.
        """
        assert_supported(self.capabilities, "virtualAccounts.createDynamic")
        self._assert_reference(reference, "virtualAccounts.createDynamic")

        payload: dict[str, Any] = {
            "email": email,
            "is_permanent": False,
            "tx_ref": reference,
            "amount": to_major(amount),
        }
        if expires_in_seconds is not None:
            payload["expires"] = str(expires_in_seconds)
        if narration is not None:
            payload["narration"] = narration
        if bank_code is not None:
            payload["bank_code"] = bank_code

        data, _message, _meta = self._call(
            method="POST",
            path="/virtual-account-numbers",
            operation="virtualAccounts.createDynamic",
            safety="safe",
            body=payload,
        )
        return to_virtual_account(data, reference=reference, kind="dynamic")

    def get_virtual_account(self, order_reference: str) -> VirtualAccount:
        data, _message, _meta = self._call(
            method="GET",
            path=f"/virtual-account-numbers/{order_reference}",
            operation="virtualAccounts.get",
            safety="safe",
        )
        return to_virtual_account(data)

    def update_virtual_account_bvn(self, *, order_reference: str, bvn: str) -> dict[str, Any]:
        """Update the BVN on a static virtual account. Flutterwave has no NIN equivalent."""
        data, message, _meta = self._call(
            method="PUT",
            path="/virtual-account-numbers/update-bvn",
            operation="virtualAccounts.updateKyc",
            safety="unsafe",
            body={"order_ref": order_reference, "bvn": bvn},
        )
        return {"message": message, "raw": data}

    def deactivate_virtual_account(self, order_reference: str) -> dict[str, Any]:
        data, message, _meta = self._call(
            method="PUT",
            path="/virtual-account-numbers/status/deactivate",
            operation="virtualAccounts.deactivate",
            safety="unsafe",
            body={"order_ref": order_reference},
        )
        return {"message": message, "raw": data}

    # ------------------------------------------------- split-payment accounts

    def create_split_account(
        self,
        *,
        business_name: str,
        account_number: str,
        bank_code: str,
        business_mobile: str,
        country: str = "NG",
        share_basis_points: int | None = None,
        flat_share: Money | None = None,
        business_email: str | None = None,
        business_contact: str | None = None,
    ) -> SplitAccount:
        """Create a collection subaccount -- the vendor side of a split payment.

        ``share_basis_points`` is our unit; Flutterwave wants a decimal fraction, so 900
        becomes ``0.09``. For a flat default share, pass ``flat_share`` instead.
        """
        assert_supported(self.capabilities, "splitAccounts.create")

        if (share_basis_points is None) == (flat_share is None):
            raise ValidationError(
                "flutterwave: give exactly one of share_basis_points or flat_share for a "
                "subaccount's default share. Flutterwave stores one split_type per "
                "subaccount, so it cannot be both, and it cannot be neither.",
                provider=FLUTTERWAVE_PROVIDER_NAME,
                operation="splitAccounts.create",
            )

        is_flat = flat_share is not None
        payload: dict[str, Any] = {
            "account_bank": bank_code,
            "account_number": account_number,
            "business_name": business_name,
            "business_mobile": business_mobile,
            "country": country,
            "split_type": "flat" if is_flat else "percentage",
            "split_value": (
                to_major(flat_share)
                if flat_share is not None
                else basis_points_to_fraction(share_basis_points or 0)
            ),
        }
        if business_email is not None:
            payload["business_email"] = business_email
        if business_contact is not None:
            payload["business_contact"] = business_contact

        data, _message, _meta = self._call(
            method="POST",
            path="/subaccounts",
            operation="splitAccounts.create",
            safety="safe",
            body=payload,
        )
        return to_split_account(data)

    def list_split_accounts(
        self, *, page: int | None = None
    ) -> tuple[tuple[SplitAccount, ...], Any]:
        data, _message, meta = self._call(
            method="GET",
            path="/subaccounts",
            operation="splitAccounts.list",
            safety="safe",
            query={"page": page},
        )
        items = data if isinstance(data, list) else []
        return tuple(to_split_account(item) for item in items), meta

    def update_split_account(
        self,
        *,
        subaccount_id: str,
        business_name: str | None = None,
        account_number: str | None = None,
        bank_code: str | None = None,
        share_basis_points: int | None = None,
        flat_share: Money | None = None,
    ) -> SplitAccount:
        if share_basis_points is not None and flat_share is not None:
            raise ValidationError(
                "flutterwave: give at most one of share_basis_points or flat_share.",
                provider=FLUTTERWAVE_PROVIDER_NAME,
                operation="splitAccounts.update",
            )

        payload: dict[str, Any] = {}
        if business_name is not None:
            payload["business_name"] = business_name
        if account_number is not None:
            payload["account_number"] = account_number
        if bank_code is not None:
            payload["account_bank"] = bank_code
        if share_basis_points is not None:
            payload["split_type"] = "percentage"
            payload["split_value"] = basis_points_to_fraction(share_basis_points)
        if flat_share is not None:
            payload["split_type"] = "flat"
            payload["split_value"] = to_major(flat_share)

        data, _message, _meta = self._call(
            method="PUT",
            path=f"/subaccounts/{subaccount_id}",
            operation="splitAccounts.update",
            safety="unsafe",
            body=payload,
        )
        return to_split_account(data)

    def deactivate_split_account(self, subaccount_id: str) -> dict[str, Any]:
        data, message, _meta = self._call(
            method="DELETE",
            path=f"/subaccounts/{subaccount_id}",
            operation="splitAccounts.deactivate",
            safety="unsafe",
        )
        return {"message": message, "raw": data}

    def create_split(self, parties: Sequence[Mapping[str, Any]]) -> tuple[dict[str, Any], ...]:
        """Build a split declaration for a checkout.

        **Makes no network call.** Flutterwave has no split object: unlike Paystack,
        which creates a ``SPL_`` code you reuse, Flutterwave declares the split inline on
        each payment. This returns the entries to hand to ``create_checkout``, with our
        basis points converted to Flutterwave's decimal fractions.

        Each party is a mapping with ``subaccount_id`` and at most one of
        ``commission_basis_points``, ``commission_flat`` or ``subaccount_receives``, plus
        an optional ``ratio``.

        Two things worth knowing before you use it, both from Flutterwave's own docs:

        - Whoever receives the remainder bears Flutterwave's fee. With ``percentage`` or
          ``flat``, that is the subaccount; with ``flat_subaccount``, it is you.
        - ``ratio`` weights are relative, not percentages: 2, 3 and 5 split the
          settlement amount into tenths, and the settlement amount is what is left after
          your commission and Flutterwave's fee.
        """
        assert_supported(self.capabilities, "splits.create")

        out: list[dict[str, Any]] = []
        for party in parties:
            subaccount_id = party.get("subaccount_id")
            commission_bps = party.get("commission_basis_points")
            commission_flat = party.get("commission_flat")
            subaccount_receives = party.get("subaccount_receives")
            ratio = party.get("ratio")

            named = sum(
                1
                for value in (commission_bps, commission_flat, subaccount_receives)
                if value is not None
            )
            if named > 1:
                raise ValidationError(
                    f'flutterwave: subaccount "{subaccount_id}" names more than one of '
                    "commission_basis_points, commission_flat and subaccount_receives. "
                    "Flutterwave takes one transaction_charge_type per subaccount.",
                    provider=FLUTTERWAVE_PROVIDER_NAME,
                    operation="splits.create",
                )

            entry: dict[str, Any] = {"id": subaccount_id}
            if ratio is not None:
                entry["transaction_split_ratio"] = ratio
            if commission_bps is not None:
                entry["transaction_charge_type"] = "percentage"
                entry["transaction_charge"] = basis_points_to_fraction(commission_bps)
            if commission_flat is not None:
                entry["transaction_charge_type"] = "flat"
                entry["transaction_charge"] = to_major(commission_flat)
            if subaccount_receives is not None:
                entry["transaction_charge_type"] = "flat_subaccount"
                entry["transaction_charge"] = to_major(subaccount_receives)
            out.append(entry)
        return tuple(out)

    # --------------------------------------------------------------- wallets

    def open_wallet(
        self,
        *,
        account_name: str,
        email: str,
        phone: str | None = None,
        country: str = "NG",
    ) -> WalletAccount:
        """Open a payout subaccount: a real NGN wallet with its own NUBAN.

        This is the capability Paystack has no answer to. The wallet holds a balance,
        receives money through its own account number, and can pay out from that balance
        rather than from yours.

        Keep both identifiers the result carries. ``reference`` reads the balance and
        debits the wallet; ``barter_id`` is the destination for a wallet-to-wallet
        transfer.
        """
        payload: dict[str, Any] = {
            "account_name": account_name,
            "email": email,
            "country": country,
        }
        if phone is not None:
            payload["mobilenumber"] = phone

        data, _message, _meta = self._call(
            method="POST",
            path="/payout-subaccounts",
            operation="wallets.open",
            safety="safe",
            body=payload,
        )
        return to_wallet_account(data)

    def get_wallet_balance(self, *, reference: str, currency: str = "NGN") -> WalletBalance:
        """A wallet's balance.

        NGN only: Flutterwave's documentation says payout subaccount wallets are designed
        to hold NGN balances, so another currency fails locally rather than returning a
        zero that looks like an empty wallet.
        """
        assert_supported(self.capabilities, "wallets.balance")

        if currency != "NGN":
            raise ValidationError(
                f"flutterwave: payout subaccount wallets hold NGN only, so a {currency} "
                "balance does not exist. Flutterwave's own documentation states this.",
                provider=FLUTTERWAVE_PROVIDER_NAME,
                operation="wallets.balance",
            )

        data, _message, _meta = self._call(
            method="GET",
            path=f"/payout-subaccounts/{reference}/balances",
            operation="wallets.balance",
            safety="safe",
            query={"currency": currency},
        )
        return to_wallet_balance(data, reference)

    def get_wallet_statement(
        self,
        *,
        reference: str,
        from_date: str | None = None,
        to_date: str | None = None,
        page: int | None = None,
    ) -> tuple[tuple[Transaction, ...], Any]:
        data, _message, meta = self._call(
            method="GET",
            path="/payout-subaccounts/transactions",
            operation="wallets.statement",
            safety="safe",
            query={
                "account_reference": reference,
                "from": from_date,
                "to": to_date,
                "page": page,
            },
        )
        items = data if isinstance(data, list) else []
        return tuple(to_transaction(item) for item in items), meta

    def transfer_from_wallet(
        self,
        *,
        wallet_reference: str,
        amount: Money,
        reference: str,
        account_number: str | None = None,
        bank_code: str | None = None,
        to_barter_id: str | None = None,
        narration: str | None = None,
        callback_url: str | None = None,
    ) -> Payout:
        """Pay out from a wallet's own balance rather than yours.

        The same endpoint as ``create_payout``, with ``debit_subaccount`` naming the
        wallet. Destination is either a bank account, or another wallet by its barter id.
        """
        assert_supported(self.capabilities, "wallets.transfer")
        self._assert_reference(reference, "wallets.transfer")

        to_bank = account_number is not None and bank_code is not None
        to_wallet = to_barter_id is not None
        if to_bank == to_wallet:
            raise ValidationError(
                "flutterwave: a wallet transfer needs exactly one destination -- either "
                "account_number with bank_code, or to_barter_id for another wallet.",
                provider=FLUTTERWAVE_PROVIDER_NAME,
                operation="wallets.transfer",
            )

        payload: dict[str, Any] = {
            # Flutterwave's own sentinel for an internal destination.
            "account_bank": "flutterwave" if to_wallet else bank_code,
            "account_number": to_barter_id if to_wallet else account_number,
            "amount": to_major(amount),
            "currency": amount.currency,
            "debit_currency": amount.currency,
            "debit_subaccount": wallet_reference,
            "reference": reference,
        }
        if narration is not None:
            payload["narration"] = narration
        if callback_url is not None:
            payload["callback_url"] = callback_url

        data, _message, _meta = self._call(
            method="POST",
            path="/transfers",
            operation="wallets.transfer",
            safety="money-moving",
            reference=reference,
            body=payload,
        )
        return to_payout(data)

    # --------------------------------------------------------------- payouts

    def list_banks(self, country: str = "NG") -> tuple[dict[str, Any], ...]:
        data, _message, _meta = self._call(
            method="GET",
            path=f"/banks/{country}",
            operation="banks.list",
            safety="safe",
        )
        items = data if isinstance(data, list) else []

        out: list[dict[str, Any]] = []
        for bank in items:
            bag = bank if isinstance(bank, dict) else {}
            raw_id = bag.get("id")
            enriched = enrich(
                account_number="",
                account_name="",
                bank_name=bag.get("name"),
                bank_code=bag.get("code"),
                bank_id=None if raw_id is None else str(raw_id),
            )
            out.append(
                {
                    "code": bag.get("code") or "",
                    "name": bag.get("name") or "",
                    "id": "" if raw_id is None else str(raw_id),
                    "institution": enriched.institution,
                    "merger_warning": enriched.merger_warning,
                }
            )
        return tuple(out)

    def resolve_account(self, *, account_number: str, bank_code: str) -> BankAccount:
        """Resolve an account number to its holder's name.

        Flutterwave's response does not echo the bank code, so the requested code is
        carried through -- otherwise the enriched result would have no code to match on.
        """
        data, _message, _meta = self._call(
            method="POST",
            path="/accounts/resolve",
            operation="banks.resolveAccount",
            # A lookup with no side effect, despite being a POST.
            safety="safe",
            body={"account_number": account_number, "account_bank": bank_code},
        )
        bag = data if isinstance(data, dict) else {}
        return enrich(
            account_number=bag.get("account_number") or account_number,
            account_name=bag.get("account_name") or "",
            bank_code=bank_code,
        )

    def create_payout(
        self,
        *,
        amount: Money,
        account_number: str,
        bank_code: str,
        reference: str,
        account_name: str | None = None,
        narration: str | None = None,
        callback_url: str | None = None,
        debit_currency: str | None = None,
    ) -> Payout:
        """Send money to a bank account.

        Unlike Paystack, Flutterwave needs no recipient object first -- the account
        number and bank code go straight on the transfer. The returned payout is
        ``pending``, not successful: Flutterwave queues transfers, and ``data.status`` is
        ``NEW``.
        """
        assert_supported(self.capabilities, "payouts.create")
        self._assert_reference(reference, "payouts.create")

        payload: dict[str, Any] = {
            "account_bank": bank_code,
            "account_number": account_number,
            "amount": to_major(amount),
            "currency": amount.currency,
            "debit_currency": debit_currency or amount.currency,
            "reference": reference,
        }
        if narration is not None:
            payload["narration"] = narration
        if account_name is not None:
            payload["beneficiary_name"] = account_name
        if callback_url is not None:
            payload["callback_url"] = callback_url

        data, _message, _meta = self._call(
            method="POST",
            path="/transfers",
            operation="payouts.create",
            # The money-moving call. Never retried, never failed over.
            safety="money-moving",
            reference=reference,
            body=payload,
        )
        return to_payout(data)

    def get_payout(self, transfer_id: str | int) -> Payout:
        """A transfer's current state, by Flutterwave's numeric transfer id."""
        data, _message, _meta = self._call(
            method="GET",
            path=f"/transfers/{transfer_id}",
            operation="payouts.status",
            safety="safe",
        )
        return to_payout(data)

    def get_balance(self) -> tuple[dict[str, Any], ...]:
        """Balances, as integer minor units.

        Flutterwave reports these as decimals -- ``20000.5`` is NGN 20,000.50 -- and they
        are converted here, so a caller never has to know that.
        """
        data, _message, _meta = self._call(
            method="GET",
            path="/balances",
            operation="balance.get",
            safety="safe",
        )
        items = data if isinstance(data, list) else []

        out: list[dict[str, Any]] = []
        for entry in items:
            bag = entry if isinstance(entry, dict) else {}
            currency = bag.get("currency") or "NGN"
            balance = to_wallet_balance(
                {"currency": currency, "available_balance": bag.get("available_balance")}, ""
            )
            # A balance we cannot convert exactly is omitted rather than reported as
            # zero, which would read as an empty account.
            if balance.available is not None:
                out.append({"amount": balance.available.amount, "currency": currency})
        return tuple(out)

    # ---------------------------------------------------------------- webhooks

    def verify_webhook(self, *, body: bytes, headers: Mapping[str, str]) -> dict[str, Any]:
        """Verify a webhook from Flutterwave.

        ``body`` must be the raw bytes exactly as received. Parsing or re-serialising
        first guarantees a mismatch, and it is the single most common cause of "my
        signature does not verify".

        Flutterwave has two schemes, and this picks by the headers present:

        - ``flutterwave-signature`` (v4) is a real HMAC-SHA256 over the raw body.
          Verified properly and reported as ``full-body``.
        - ``verif-hash`` (v3) carries the secret hash itself. Identical on every request,
          covering none of the payload, so it proves only that the sender knows the
          secret. Reported as ``shared-secret``, never dressed up as a signature.

        The ``strength`` in the result is the strength of the scheme actually used, so an
        application that requires ``full-body`` can refuse a v3 delivery. Both schemes
        use the secret hash from the dashboard, which is ``webhook_secret_hash``, not the
        API key.
        """
        assert_supported(self.capabilities, "webhooks.verify")

        if self._webhook_secret_hash is None:
            raise ConfigurationError(
                "flutterwave: webhook_secret_hash is required to verify webhooks. It is "
                "the secret hash you set under Settings > Webhooks on the Flutterwave "
                "dashboard, and it is not the API secret key -- unlike Paystack, which "
                "signs with the secret key.",
                provider=FLUTTERWAVE_PROVIDER_NAME,
                operation="webhooks.verify",
            )

        lowered = {key.lower(): value for key, value in headers.items()}
        has_v4 = isinstance(lowered.get("flutterwave-signature"), str)
        has_v3 = isinstance(lowered.get("verif-hash"), str)

        if not has_v4 and not has_v3:
            return {
                "verified": False,
                "strength": "unverified",
                "reason": (
                    'neither the "flutterwave-signature" header (v4) nor the '
                    '"verif-hash" header (v3) is present, so this delivery cannot be '
                    "verified at all."
                ),
                "api_version": "unknown",
            }

        # v4 first: when both are present, verify the one that actually proves something.
        scheme = SCHEMES["flutterwaveV4"] if has_v4 else SCHEMES["flutterwaveV3"]
        result = verify_signature(
            scheme=scheme,
            body=body,
            headers=lowered,
            secret=self._webhook_secret_hash,
        )
        return {
            "verified": result.verified,
            "strength": result.strength,
            "reason": result.reason,
            "api_version": "v4" if has_v4 else "v3",
        }


def flutterwave(**kwargs: Any) -> FlutterwaveProvider:
    """Create a Flutterwave provider."""
    return FlutterwaveProvider(**kwargs)


__all__ = ["FlutterwaveProvider", "flutterwave"]
