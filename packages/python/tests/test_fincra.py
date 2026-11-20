"""Fincra adapter tests, mirroring packages/ts/test/fincra.test.ts.

Everything runs against the recorded fixtures in fixtures/providers/fincra/ through a
fake transport, so there is no network and no keys.
"""

import json
import pathlib
import sys
import unittest
from datetime import datetime, timezone
from typing import Any

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "src"))

from naija_pay.core.capabilities import assert_supported, supports
from naija_pay.core.errors import (
    ConfigurationError,
    DuplicateReferenceError,
    InsufficientFundsError,
    KycRequiredError,
    NotFoundError,
    PayoutStatusUnknownError,
    UnsupportedOperationError,
    ValidationError,
)
from naija_pay.core.http import TransportRequest, TransportResponse
from naija_pay.core.money import money, naira
from naija_pay.core.signatures import SCHEMES, compute_signature
from naija_pay.providers.fincra import FincraProvider, fincra
from naija_pay.providers.fincra.normalise import (
    as_money,
    normalise_payout_status,
    normalise_status,
    to_bvn_verification,
    to_refund,
)

FIXTURES = pathlib.Path(__file__).resolve().parents[3] / "fixtures" / "providers" / "fincra"

SECRET_KEY = "EXAMPLEfincrasecretkey0000000000"
WEBHOOK_KEY = "EXAMPLEfincrawebhookkey000000000"
BUSINESS_ID = "64f000000000000000000001"

PAYLOAD = json.dumps(
    {
        "event": "charge.successful",
        "data": {"reference": "order-01HQ-EXAMPLE", "status": "success"},
    },
    separators=(",", ":"),
)

_UNSET = object()


def fixture(operation: str) -> Any:
    """Loads a recorded response, so no test invents a provider payload."""
    return json.loads((FIXTURES / operation / "response.json").read_text(encoding="utf-8"))


class Harness:
    """Serves fixtures in order, recording the requests the adapter made."""

    def __init__(self, steps: list[Any]) -> None:
        self.steps = steps
        self.requests: list[TransportRequest] = []

    def send(self, request: TransportRequest) -> TransportResponse:
        self.requests.append(request)
        step = self.steps[min(len(self.requests) - 1, len(self.steps) - 1)]
        if isinstance(step, str):
            status, body = 200, fixture(step)
        else:
            status, body = step
        return TransportResponse(
            status=status,
            headers={"content-type": "application/json"},
            text=json.dumps(body),
        )

    def body(self, index: int) -> Any:
        assert len(self.requests) > index, (
            f"expected at least {index + 1} request(s), got {len(self.requests)}"
        )
        raw = self.requests[index].body
        return json.loads(raw) if raw else None

    def at(self, index: int) -> TransportRequest:
        assert len(self.requests) > index, (
            f"expected at least {index + 1} request(s), got {len(self.requests)}"
        )
        return self.requests[index]


def make(
    steps: list[Any],
    *,
    business_id: Any = _UNSET,
    webhook_secret_key: Any = _UNSET,
) -> tuple[Any, Harness]:
    harness = Harness(steps)
    provider = fincra(
        secret_key=SECRET_KEY,
        business_id=BUSINESS_ID if business_id is _UNSET else business_id,
        webhook_secret_key=WEBHOOK_KEY if webhook_secret_key is _UNSET else webhook_secret_key,
        environment="test",
        transport=harness,
        sleep=lambda _seconds: None,
    )
    return provider, harness


class TestConstructionAndKeySafety(unittest.TestCase):
    def test_requires_a_secret_key_and_says_where_it_lives(self) -> None:
        with self.assertRaises(ConfigurationError) as ctx:
            fincra(secret_key="", transport=Harness([]))
        self.assertIn("api-key", str(ctx.exception))

    def test_defaults_to_the_sandbox_host(self) -> None:
        provider, harness = make(["banks-list"])
        provider.list_banks()
        self.assertTrue(harness.at(0).url.startswith("https://sandboxapi.fincra.com/"))

    def test_warns_loudly_when_the_environment_is_live_outside_production(self) -> None:
        warnings: list[str] = []
        fincra(
            secret_key=SECRET_KEY,
            environment="live",
            transport=Harness([]),
            on_live_key_warning=warnings.append,
        )
        self.assertEqual(len(warnings), 1)
        # Fincra publishes no key prefix, so the environment is the only signal there is.
        self.assertIn("no key prefix", warnings[0])
        self.assertIn("Real money will move", warnings[0])

    def test_authenticates_with_api_key_not_authorization(self) -> None:
        # A Bearer token is silently ignored by Fincra, and the reply blames a missing key.
        provider, harness = make(["banks-list"])
        provider.list_banks()
        headers = harness.at(0).headers
        self.assertEqual(headers["api-key"], SECRET_KEY)
        self.assertNotIn("authorization", headers)

    def test_a_call_that_needs_the_business_id_says_so_when_there_is_none(self) -> None:
        provider, harness = make(["wallets-list"], business_id=None)
        with self.assertRaises(ConfigurationError) as ctx:
            provider.get_balance()
        self.assertIn("get_business()", str(ctx.exception))
        self.assertEqual(len(harness.requests), 0)


class TestTheEnvelope(unittest.TestCase):
    def test_checkout_says_status_and_payouts_say_success(self) -> None:
        # Both names, one meaning. Reading only one of them would fail every other call.
        self.assertEqual(fixture("checkout-initialize")["status"], True)
        self.assertEqual(fixture("payout-create-processing")["success"], True)

        provider, _ = make(["checkout-initialize"])
        checkout = provider.create_checkout(
            amount=naira(350),
            email="ada@example.com",
            name="Ada Example",
            reference="order-01HQ-EXAMPLE",
        )
        self.assertTrue(checkout["checkout_url"].startswith("https://sandbox-checkout.fincra.com/"))

    def test_status_false_on_an_http_200_is_a_failure(self) -> None:
        provider, _ = make([(200, {"status": False, "message": "Duplicate reference"})])
        with self.assertRaises(DuplicateReferenceError):
            provider.create_checkout(
                amount=naira(350),
                email="ada@example.com",
                name="Ada Example",
                reference="order-01HQ-EXAMPLE",
            )

    def test_an_envelope_with_neither_key_is_treated_as_success(self) -> None:
        # So an endpoint that spells it a third way does not fail every call.
        provider, _ = make(
            [
                (
                    200,
                    {
                        "message": "ok",
                        "data": {"accountNumber": "0123456789", "accountName": "ADA EXAMPLE"},
                    },
                )
            ]
        )
        account = provider.resolve_account(account_number="0123456789", bank_code="044")
        self.assertEqual(account.account_name, "ADA EXAMPLE")

    def test_an_entitlement_message_reads_as_configuration(self) -> None:
        provider, _ = make(
            [
                (
                    403,
                    {
                        "success": False,
                        "message": "Your IP is not whitelisted, contact support",
                    },
                )
            ]
        )
        with self.assertRaises(ConfigurationError) as ctx:
            provider.list_banks()
        self.assertIn("whitelisted", str(ctx.exception))

    def test_an_insufficient_balance_message_is_its_own_error(self) -> None:
        provider, _ = make([(400, {"success": False, "message": "Insufficient balance"})])
        with self.assertRaises(InsufficientFundsError):
            provider.create_payout(
                amount=naira(1000),
                reference="payout-01HQ-EXAMPLE",
                beneficiary={
                    "account_number": "0123456789",
                    "bank_code": "044",
                    "account_holder_name": "Ada Example",
                },
            )


class TestCollections(unittest.TestCase):
    def test_the_amount_goes_out_as_decimal_major_units(self) -> None:
        provider, harness = make(["checkout-initialize"])
        provider.create_checkout(
            amount=money(350_050, "NGN"),
            email="ada@example.com",
            name="Ada Example",
            reference="order-01HQ-EXAMPLE",
            channels=["card", "bank_transfer"],
            phone="09022222222",
        )

        body = harness.body(0)
        # 350050 kobo is 3500.50 naira.
        self.assertEqual(body["amount"], 3500.5)
        self.assertEqual(body["currency"], "NGN")
        self.assertEqual(body["paymentMethods"], ["card", "bank_transfer"])
        self.assertEqual(body["customer"]["phoneNumber"], "09022222222")

    def test_refuses_a_currency_fincra_does_not_document(self) -> None:
        provider, harness = make(["checkout-initialize"])
        with self.assertRaises(ValidationError) as ctx:
            provider.create_checkout(
                amount=money(1000, "ZAR"),
                email="ada@example.com",
                name="Ada Example",
                reference="order-01HQ-EXAMPLE",
            )
        self.assertIn("not one of the currencies Fincra documents", str(ctx.exception))
        self.assertEqual(len(harness.requests), 0)

    def test_refuses_a_channel_fincra_does_not_have(self) -> None:
        provider, harness = make(["checkout-initialize"])
        with self.assertRaises(ValidationError) as ctx:
            provider.create_checkout(
                amount=naira(350),
                email="ada@example.com",
                name="Ada Example",
                reference="order-01HQ-EXAMPLE",
                channels=["apple_pay"],
            )
        self.assertIn("does not support the channel(s): apple_pay", str(ctx.exception))
        self.assertEqual(len(harness.requests), 0)

    def test_verify_is_by_your_reference_and_carries_the_business_id_header(self) -> None:
        # The opposite of Flutterwave: Fincra has no verify-by-its-own-reference route
        # for checkout, and this one call needs x-business-id.
        provider, harness = make(["checkout-verify-success"])
        transaction = provider.verify_transaction("order-01HQ-EXAMPLE")

        self.assertTrue(
            harness.at(0).url.endswith("/checkout/payments/merchant-reference/order-01HQ-EXAMPLE")
        )
        self.assertEqual(harness.at(0).headers["x-business-id"], BUSINESS_ID)
        self.assertEqual(transaction.status, "successful")
        assert transaction.amount is not None
        self.assertEqual(transaction.amount.amount, 35_000)
        self.assertEqual(transaction.reference, "order-01HQ-EXAMPLE")

    def test_the_channel_on_a_verified_payment_is_normalised(self) -> None:
        provider, _ = make(["checkout-verify-success"])
        transaction = provider.verify_transaction("order-01HQ-EXAMPLE")
        # The fixture lists card, bank_transfer and payattitude.
        self.assertEqual(transaction.channel, "bank_transfer")


class TestRefunds(unittest.TestCase):
    def test_a_refund_is_full_amount_only(self) -> None:
        provider, harness = make(["refund-status"])
        provider.create_refund("96d1fc1c-2570-EXAMPLE")

        # There is no amount field on Fincra's refund endpoint at all.
        self.assertEqual(harness.body(0), {"transReference": "96d1fc1c-2570-EXAMPLE"})
        self.assertTrue(harness.at(0).url.endswith("/collections/refund"))

    def test_a_refund_is_money_moving_and_is_never_retried(self) -> None:
        provider, harness = make([(503, {"success": False, "message": "Service unavailable"})])
        with self.assertRaises(PayoutStatusUnknownError):
            provider.create_refund("96d1fc1c-2570-EXAMPLE")
        self.assertEqual(len(harness.requests), 1)

    def test_six_decimal_refund_amounts_are_read_exactly_or_not_at_all(self) -> None:
        provider, _ = make(["refund-status"])
        refund = provider.get_refund("cba44033-bcaa-EXAMPLE")

        # "5914.000000" is exactly 591400 kobo.
        assert refund.amount is not None
        self.assertEqual(refund.amount.amount, 591_400)
        self.assertEqual(refund.status, "processing")
        self.assertEqual(refund.reason, "overpayment")
        assert refund.destination is not None
        self.assertEqual(refund.destination.bank_code, "042")

    def test_a_refunds_zoneless_timestamps_are_read_as_utc(self) -> None:
        # "2023-12-07 17:39:00" with no offset: Python's fromisoformat would otherwise
        # return a naive datetime and JavaScript would read it as local time, so the two
        # packages would disagree about the instant.
        refund = to_refund(
            {
                "reference": "cba44033-bcaa-EXAMPLE",
                "amountRefunded": "100.000000",
                "refundStatus": "processing",
                "completedAt": "2023-12-07 17:39:00",
            }
        )
        self.assertEqual(refund.raw["completedAt"], "2023-12-07 17:39:00")
        # The fixture carries the same shape, which is what makes this worth pinning.
        self.assertRegex(
            fixture("refund-status")["data"]["completedAt"],
            r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$",
        )

    def test_listing_refunds_needs_the_business_id_as_a_query_parameter(self) -> None:
        provider, harness = make([(200, {"success": True, "data": {"results": []}})])
        provider.list_refunds()
        self.assertIn("business=64f000000000000000000001", harness.at(0).url)


class TestVirtualAccounts(unittest.TestCase):
    def test_an_ngn_account_requires_a_bvn(self) -> None:
        provider, harness = make(["virtual-account-create"])
        with self.assertRaises(KycRequiredError) as ctx:
            provider.create_virtual_account(
                currency="NGN",
                account_type="individual",
                first_name="Ada",
                last_name="Example",
            )
        self.assertEqual(list(ctx.exception.required), ["bvn"])
        self.assertEqual(len(harness.requests), 0)

    def test_a_corporate_account_requires_business_name_and_bvn_name(self) -> None:
        provider, _ = make(["virtual-account-create"])
        with self.assertRaises(ValidationError) as ctx:
            provider.create_virtual_account(
                currency="NGN",
                account_type="corporate",
                bvn="21212121212",
                business_name="Example Ltd",
            )
        self.assertIn("requires both business_name and bvn_name", str(ctx.exception))

    def test_an_individual_account_requires_both_names(self) -> None:
        provider, _ = make(["virtual-account-create"])
        with self.assertRaises(ValidationError) as ctx:
            provider.create_virtual_account(
                currency="NGN",
                account_type="individual",
                bvn="21212121212",
                first_name="Ada",
            )
        self.assertIn("requires both first_name and last_name", str(ctx.exception))

    def test_a_bank_channel_published_as_disabled_is_refused_locally(self) -> None:
        # Two of the nine are disabled in Fincra's own table, which is why the choice has
        # to be a capability query rather than an enum.
        provider, harness = make(["virtual-account-create"])
        with self.assertRaises(ValidationError) as ctx:
            provider.create_virtual_account(
                currency="NGN",
                account_type="individual",
                bvn="21212121212",
                first_name="Ada",
                last_name="Example",
                channel="providus",
            )
        self.assertIn("published as DISABLED", str(ctx.exception))

        with self.assertRaises(ValidationError) as ctx2:
            provider.create_virtual_account(
                currency="NGN",
                account_type="individual",
                bvn="21212121212",
                first_name="Ada",
                last_name="Example",
                channel="not-a-bank",
            )
        self.assertIn("is not one of the bank channels Fincra publishes", str(ctx2.exception))
        self.assertEqual(len(harness.requests), 0)

    def test_an_approved_request_is_the_only_one_read_as_verified(self) -> None:
        provider, harness = make(["virtual-account-create"])
        account = provider.create_virtual_account(
            currency="NGN",
            account_type="individual",
            bvn="21212121212",
            first_name="Ada",
            last_name="Example",
            reference="va-ada-EXAMPLE",
            channel="globus",
        )

        body = harness.body(0)
        self.assertEqual(body["KYCInformation"]["bvn"], "21212121212")
        self.assertEqual(body["channel"], "globus")
        self.assertEqual(account.kyc_status, "verified")
        self.assertEqual(account.kind, "static")
        self.assertEqual(account.accounts[0].account_number, "1234567890")

    def test_a_pending_request_is_not_read_as_verified(self) -> None:
        provider, _ = make([(200, {"success": True, "data": {"_id": "x", "status": "pending"}})])
        account = provider.create_virtual_account(
            currency="NGN",
            account_type="individual",
            bvn="21212121212",
            first_name="Ada",
            last_name="Example",
        )
        self.assertEqual(account.kyc_status, "pending")

    def test_a_temporary_account_sends_its_amount_as_a_string(self) -> None:
        provider, harness = make(["virtual-account-create"])
        provider.create_dynamic_virtual_account(
            amount=naira(350),
            expires_at=datetime(2026, 12, 1, tzinfo=timezone.utc),
            reference="va-dyn-EXAMPLE",
        )

        body = harness.body(0)
        self.assertIsInstance(body["amount"], str)
        self.assertEqual(body["amount"], "350")
        self.assertEqual(body["expiresAt"], "2026-12-01T00:00:00+00:00")

    def test_a_temporary_account_is_ngn_only(self) -> None:
        provider, _ = make(["virtual-account-create"])
        with self.assertRaises(ValidationError) as ctx:
            provider.create_dynamic_virtual_account(
                amount=money(1000, "USD"),
                expires_at="2026-12-01T00:00:00.000Z",
            )
        self.assertIn("NGN only", str(ctx.exception))

    def test_a_bvn_lookup_is_a_lookup_not_a_way_to_read_account_numbers_back(self) -> None:
        # Fincra masks the response with asterisks, which is worth knowing before relying
        # on it.
        provider, harness = make(
            [
                (
                    200,
                    {
                        "success": True,
                        "data": {
                            "results": [{"_id": "x", "accountNumber": "****", "status": "approved"}]
                        },
                    },
                )
            ]
        )
        page = provider.find_virtual_accounts_by_bvn("21212121212")
        self.assertIn("bvn=21212121212", harness.at(0).url)
        self.assertEqual(len(page.items), 1)


class TestPayouts(unittest.TestCase):
    def test_success_true_with_status_processing_is_pending(self) -> None:
        # Fincra's own documentation says success means the request was accepted. Reading
        # it as settlement is the most expensive mistake available in this file.
        provider, _ = make(["payout-create-processing"])
        payout = provider.create_payout(
            amount=naira(1000),
            reference="payout-01HQ-EXAMPLE",
            description="Payout",
            beneficiary={
                "account_number": "0123456789",
                "bank_code": "044",
                "account_holder_name": "Ada Example",
            },
        )

        self.assertEqual(payout.status, "pending")
        self.assertEqual(payout.awaiting_document, False)

    def test_the_fixture_really_says_success_and_processing_together(self) -> None:
        response = fixture("payout-create-processing")
        self.assertEqual(response["success"], True)
        self.assertEqual(response["data"]["status"], "processing")

    def test_the_payout_amount_is_a_number(self) -> None:
        provider, harness = make(["payout-create-processing"])
        provider.create_payout(
            amount=naira(1000),
            reference="payout-01HQ-EXAMPLE",
            beneficiary={
                "account_number": "0123456789",
                "bank_code": "044",
                "account_holder_name": "Ada Example",
            },
        )

        body = harness.body(0)
        # Fincra's own page says "Do not send it as a string".
        self.assertIsInstance(body["amount"], (int, float))
        self.assertNotIsInstance(body["amount"], str)
        self.assertEqual(body["amount"], 1000)
        self.assertEqual(body["business"], BUSINESS_ID)
        self.assertEqual(body["paymentDestination"], "bank_account")
        self.assertEqual(body["beneficiary"]["type"], "individual")
        self.assertEqual(body["beneficiary"]["country"], "NG")

    def test_a_cross_currency_payout_without_a_quote_is_refused_locally(self) -> None:
        provider, harness = make(["payout-create-processing"])
        with self.assertRaises(ValidationError) as ctx:
            provider.create_payout(
                amount=naira(1000),
                reference="payout-01HQ-EXAMPLE",
                destination_currency="USD",
                beneficiary={
                    "account_number": "0123456789",
                    "bank_code": "044",
                    "account_holder_name": "Ada Example",
                },
            )
        self.assertIn("requires a quote_reference", str(ctx.exception))
        self.assertEqual(len(harness.requests), 0)

    def test_a_payout_is_never_retried_and_a_503_reports_an_unknown_outcome(self) -> None:
        provider, harness = make([(503, {"success": False, "message": "Service unavailable"})])
        with self.assertRaises(PayoutStatusUnknownError) as ctx:
            provider.create_payout(
                amount=naira(1000),
                reference="payout-01HQ-EXAMPLE",
                beneficiary={
                    "account_number": "0123456789",
                    "bank_code": "044",
                    "account_holder_name": "Ada Example",
                },
            )
        self.assertIn("must NOT be retried", str(ctx.exception))
        self.assertEqual(len(harness.requests), 1)

    def test_a_fee_no_currency_can_represent_is_none(self) -> None:
        provider, _ = make(["payout-verify-cross-currency"])
        payout = provider.get_payout("db396365d80bEXAMPLE")

        # fee: 9090.909091 -- six decimal places, which no currency has.
        self.assertIsNone(payout.fee)
        # And the exact figure is still there for anyone who needs it.
        self.assertEqual(payout.raw["fee"], 9090.909091)
        self.assertEqual(payout.source_currency, "KES")
        self.assertEqual(payout.destination_currency, "EUR")
        self.assertEqual(payout.status, "successful")

    def test_your_own_reference_and_fincras_are_different_routes(self) -> None:
        provider, harness = make(["payout-verify-cross-currency", "payout-verify-cross-currency"])
        provider.get_payout("db396365d80bEXAMPLE")
        provider.get_payout_by_reference("payout-01HQ-EXAMPLE")

        self.assertTrue(
            harness.at(0).url.endswith("/disbursements/payouts/reference/db396365d80bEXAMPLE")
        )
        self.assertTrue(
            harness.at(1).url.endswith(
                "/disbursements/payouts/customer-reference/payout-01HQ-EXAMPLE"
            )
        )

    def test_listing_payouts_sends_filters_as_query_parameters(self) -> None:
        # Fincra's reference page documents a GET with a request body, which most servers
        # do not read. Recorded in PROVIDERS.md.
        provider, harness = make([(200, {"success": True, "data": {"results": []}})])
        provider.list_payouts(page=2, per_page=50, status="successful")

        request = harness.at(0)
        self.assertEqual(request.method, "GET")
        self.assertIsNone(request.body)
        self.assertIn("page=2", request.url)
        self.assertIn("perPage=50", request.url)
        self.assertIn("status=successful", request.url)

    def test_a_payout_waiting_is_pending(self) -> None:
        # Fincra's equivalent of Monnify's OTP gate: accepted, and going nowhere.
        self.assertEqual(normalise_payout_status("processing"), "pending")


class TestBanksBalanceAndIdentity(unittest.TestCase):
    def test_banks_default_to_nigeria_and_keep_fincras_own_codes(self) -> None:
        provider, harness = make(["banks-list"])
        banks = provider.list_banks()

        self.assertIn("country=NG", harness.at(0).url)
        self.assertEqual(banks[0].code, "044")
        self.assertEqual(banks[0].name, "Access Bank")
        # Fincra also publishes the NIBSS code, which is the one that matters for
        # transfers.
        self.assertEqual(banks[0].raw["nibssCode"], "044")

    def test_a_nuban_resolve_is_a_post_and_carries_the_bank_code_we_passed(self) -> None:
        # Fincra does not echo the bank code back, so the adapter keeps the caller's.
        provider, harness = make(["account-resolve"])
        account = provider.resolve_account(account_number="0123456789", bank_code="044")

        self.assertEqual(harness.at(0).method, "POST")
        self.assertEqual(
            harness.body(0),
            {"type": "nuban", "accountNumber": "0123456789", "bankCode": "044"},
        )
        self.assertEqual(account.bank_code, "044")
        self.assertIsNotNone(account.institution)

    def test_wallet_balances_come_back_one_per_currency(self) -> None:
        provider, harness = make(["wallets-list"])
        wallets = provider.get_balance()

        self.assertIn("businessID=64f000000000000000000001", harness.at(0).url)
        ngn = next(wallet for wallet in wallets if wallet.currency == "NGN")
        gbp = next(wallet for wallet in wallets if wallet.currency == "GBP")
        # 1999792413.990817 has six decimal places: not representable in kobo.
        self.assertIsNone(ngn.available)
        self.assertIsNone(gbp.available)
        # The exact figures stay in raw.
        self.assertEqual(gbp.raw["availableBalance"], 4145.558824)

    def test_get_business_is_how_you_find_the_id(self) -> None:
        provider, harness = make([(200, {"success": True, "data": {"_id": BUSINESS_ID}})])
        business = provider.get_business()
        self.assertTrue(harness.at(0).url.endswith("/profile/business/me"))
        self.assertEqual(business["id"], BUSINESS_ID)

    def test_a_bvn_verification_never_carries_the_photograph(self) -> None:
        provider, _ = make(["bvn-verification"])
        result = provider.verify_bvn("21212121212")

        self.assertEqual(result.verified, True)
        self.assertEqual(result.first_name, "ADA")
        self.assertEqual(result.last_name, "EXAMPLE")
        # Fincra's own date wording, not parsed into a datetime.
        self.assertEqual(result.date_of_birth, "15-Jul-2022")
        # The photograph is dropped from the object AND from raw.
        self.assertNotIn("pixBase64", json.dumps(result.raw))
        self.assertNotIn("pixBase64", repr(result))

    def test_the_fixture_really_does_carry_a_photograph(self) -> None:
        response = fixture("bvn-verification")["data"]["response"]
        self.assertIsInstance(response["pixBase64"], str)

    def test_a_bvn_is_never_put_in_a_url(self) -> None:
        # It goes in the body of a POST. A BVN in a query string ends up in access logs.
        provider, harness = make(["bvn-verification"])
        provider.verify_bvn("21212121212")
        self.assertNotIn("21212121212", harness.at(0).url)
        self.assertEqual(harness.body(0)["bvn"], "21212121212")


class TestWebhooks(unittest.TestCase):
    def test_a_signature_over_the_raw_bytes_verifies(self) -> None:
        provider, _ = make([])
        body = PAYLOAD.encode("utf-8")
        signature = compute_signature(scheme=SCHEMES["fincra"], body=body, secret=WEBHOOK_KEY)

        result = provider.verify_webhook(body=body, headers={"signature": signature})
        self.assertEqual(result.verified, True)
        self.assertEqual(result.strength, "full-body")
        self.assertEqual(result.matched_input, "raw-body")

    def test_a_signature_over_fincras_own_reserialisation_also_verifies(self) -> None:
        # Fincra's samples hash a re-serialisation of {event, data}, not the bytes. Here
        # the bytes that arrive carry extra whitespace and a third key, so only the
        # re-serialisation can match -- which is the case worth distinguishing.
        provider, _ = make([])
        parsed = json.loads(PAYLOAD)
        delivered = json.dumps({**parsed, "extra": "ignored by the signature"}, indent=2).encode(
            "utf-8"
        )
        canonical = json.dumps(
            {"event": parsed["event"], "data": parsed["data"]},
            separators=(",", ":"),
            ensure_ascii=False,
        ).encode("utf-8")
        signature = compute_signature(scheme=SCHEMES["fincra"], body=canonical, secret=WEBHOOK_KEY)

        result = provider.verify_webhook(body=delivered, headers={"signature": signature})
        self.assertEqual(result.verified, True)
        self.assertEqual(result.matched_input, "canonical-reserialisation")

    def test_a_tampered_body_does_not_verify(self) -> None:
        provider, _ = make([])
        body = PAYLOAD.encode("utf-8")
        signature = compute_signature(scheme=SCHEMES["fincra"], body=body, secret=WEBHOOK_KEY)

        result = provider.verify_webhook(
            body=PAYLOAD.replace("success", "failed").encode("utf-8"),
            headers={"signature": signature},
        )
        self.assertEqual(result.verified, False)
        self.assertIsNone(result.matched_input)
        self.assertIn("WEBHOOK secret key", result.reason or "")

    def test_a_missing_header_is_unverified(self) -> None:
        provider, _ = make([])
        result = provider.verify_webhook(body=PAYLOAD.encode("utf-8"), headers={})
        self.assertEqual(result.verified, False)
        self.assertEqual(result.strength, "unverified")
        self.assertIn('"signature" header is missing', result.reason or "")

    def test_verifying_with_no_webhook_key_says_it_is_a_third_key(self) -> None:
        # The commonest Fincra webhook mistake: signing with the API secret key.
        provider, _ = make([], webhook_secret_key=None)
        with self.assertRaises(ConfigurationError) as ctx:
            provider.verify_webhook(body=PAYLOAD.encode("utf-8"), headers={"signature": "x"})
        self.assertIn("THIRD key", str(ctx.exception))

    def test_the_header_name_is_case_insensitive(self) -> None:
        provider, _ = make([])
        body = PAYLOAD.encode("utf-8")
        signature = compute_signature(scheme=SCHEMES["fincra"], body=body, secret=WEBHOOK_KEY)
        result = provider.verify_webhook(body=body, headers={"Signature": signature})
        self.assertEqual(result.verified, True)


class TestNormalisation(unittest.TestCase):
    def test_processing_is_pending_on_both_status_maps(self) -> None:
        self.assertEqual(normalise_status("processing"), "pending")
        self.assertEqual(normalise_payout_status("processing"), "pending")

    def test_an_unknown_status_is_pending(self) -> None:
        self.assertEqual(normalise_status("SOMETHING_NEW"), "pending")
        self.assertEqual(normalise_status(None), "pending")
        self.assertEqual(normalise_payout_status(None), "pending")

    def test_an_amount_with_more_precision_than_the_currency_has_is_none(self) -> None:
        exact = as_money(350)
        refunded = as_money("5914.000000")
        assert exact is not None and refunded is not None
        self.assertEqual(exact.amount, 35_000)
        self.assertEqual(refunded.amount, 591_400)
        # The real ones from Fincra's own samples.
        self.assertIsNone(as_money(9090.909091))
        self.assertIsNone(as_money(4145.558824))
        self.assertIsNone(as_money(-1))
        self.assertIsNone(as_money("not a number"))

    def test_a_bvn_response_with_no_photograph_still_normalises(self) -> None:
        result = to_bvn_verification(
            {
                "verificationStatus": "verified",
                "response": {"firstName": "ADA", "lastName": "EXAMPLE"},
            }
        )
        self.assertEqual(result.verified, True)
        self.assertIsNone(result.middle_name)


class TestCapabilities(unittest.TestCase):
    def test_what_fincra_does_not_have_says_why(self) -> None:
        provider, _ = make([])
        self.assertIn("different shape", provider.not_yet_implemented["splitAccounts.create"])
        self.assertIn("no batch payout route", provider.not_yet_implemented["payouts.createBulk"])
        self.assertIn(
            "never touches raw card data",
            provider.not_yet_implemented["charges.chargeAuthorization"],
        )

    def test_an_operation_fincra_does_not_have_is_declared_unsupported(self) -> None:
        provider, harness = make([])
        # Fincra has sub-accounts for multi-entity businesses, not transaction splits, so
        # the capability is declared false rather than implemented half-way.
        self.assertFalse(supports(provider.capabilities, "splits.create"))
        self.assertFalse(supports(provider.capabilities, "payouts.createBulk"))
        self.assertFalse(hasattr(provider, "create_split"))
        self.assertEqual(len(harness.requests), 0)

    def test_asking_the_core_for_an_unsupported_operation_raises(self) -> None:
        provider, _ = make([])
        with self.assertRaises(UnsupportedOperationError):
            assert_supported(provider.capabilities, "splits.create")

    def test_the_widest_currency_list_in_tier_1_is_declared(self) -> None:
        provider, _ = make([])
        currencies = provider.capabilities.currencies or ()
        self.assertIn("NGN", currencies)
        self.assertIn("KES", currencies)
        self.assertIn("EUR", currencies)

    def test_the_webhook_declaration_records_the_reserialisation_hazard(self) -> None:
        provider, _ = make([])
        signature = provider.capabilities.webhook_signature
        assert signature is not None
        self.assertEqual(signature.header, "signature")
        self.assertIn("re-serialisation", signature.notes or "")

    def test_a_404_is_a_not_found_error(self) -> None:
        provider, _ = make([(404, {"success": False, "message": "Payout not found"})])
        with self.assertRaises(NotFoundError):
            provider.get_payout("nope-EXAMPLE")

    def test_the_provider_is_the_class_it_claims_to_be(self) -> None:
        provider, _ = make([])
        self.assertIsInstance(provider, FincraProvider)
        self.assertEqual(provider.name, "fincra")


if __name__ == "__main__":
    unittest.main()
