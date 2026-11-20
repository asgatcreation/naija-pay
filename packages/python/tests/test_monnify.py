"""Monnify adapter tests, mirroring packages/ts/test/monnify.test.ts.

Everything runs against the recorded fixtures in fixtures/providers/monnify/ through a
fake transport, so there is no network and no keys. Every Monnify call needs a token, so
the harness serves the login response first unless a test asks it not to -- which keeps
each test about its own endpoint rather than about authentication.
"""

import base64
import hashlib
import json
import pathlib
import sys
import unittest
from typing import Any
from urllib.parse import unquote

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "src"))

from naija_pay.core.capabilities import operations_requiring_approval, supports
from naija_pay.core.errors import (
    AuthenticationError,
    ConfigurationError,
    DuplicateReferenceError,
    KycRequiredError,
    NotFoundError,
    PayoutStatusUnknownError,
    ValidationError,
)
from naija_pay.core.http import TransportRequest, TransportResponse
from naija_pay.core.money import money, naira
from naija_pay.core.signatures import SCHEMES, compute_signature
from naija_pay.providers.monnify import MonnifyProvider, monnify
from naija_pay.providers.monnify.normalise import (
    as_money,
    normalise_status,
    normalise_transfer_status,
    parse_monnify_date,
    to_transaction,
)

FIXTURES = pathlib.Path(__file__).resolve().parents[3] / "fixtures" / "providers" / "monnify"

API_KEY = "MK_TEST_EXAMPLEmonnify"
SECRET_KEY = "EXAMPLEsecretkeyformonnifytests0"
CONTRACT_CODE = "5867418298"
WALLET = "3934178936"


def fixture(operation: str) -> dict[str, Any]:
    """Loads a recorded response, so no test invents a provider payload."""
    return json.loads((FIXTURES / operation / "response.json").read_text(encoding="utf-8"))


def fixture_file(operation: str, name: str) -> str:
    return (FIXTURES / operation / name).read_text(encoding="utf-8")


class Harness:
    """Serves fixtures in order, recording the requests the adapter made."""

    def __init__(self, steps: list[Any], *, skip_login: bool = False) -> None:
        self.steps: list[Any] = list(steps) if skip_login else ["auth-login", *steps]
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
        """The JSON body of the nth recorded request, asserting the request happened."""
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

    def logins(self) -> int:
        return len([r for r in self.requests if r.url.endswith("/auth/login")])


def make(steps: list[Any], *, skip_login: bool = False, **extra: Any) -> tuple[Any, Harness]:
    harness = Harness(steps, skip_login=skip_login)
    provider = monnify(
        api_key=API_KEY,
        secret_key=SECRET_KEY,
        contract_code=CONTRACT_CODE,
        wallet_account_number=WALLET,
        environment="test",
        transport=harness,
        sleep=lambda _seconds: None,
        **extra,
    )
    return provider, harness


class TestConstructionAndKeySafety(unittest.TestCase):
    def test_accepts_a_test_key_pair(self) -> None:
        provider = monnify(
            api_key=API_KEY, secret_key=SECRET_KEY, environment="test", transport=Harness([])
        )
        self.assertEqual(provider.name, "monnify")

    def test_requires_both_halves_of_the_credential(self) -> None:
        with self.assertRaises(ConfigurationError):
            monnify(api_key=API_KEY, secret_key="", transport=Harness([]))
        with self.assertRaises(ConfigurationError):
            monnify(api_key="", secret_key=SECRET_KEY, transport=Harness([]))

    def test_refuses_something_that_is_not_an_api_key(self) -> None:
        # The secret key is longer and has no prefix, and passing the two the wrong way
        # round is the obvious mistake to catch locally.
        with self.assertRaises(ConfigurationError) as ctx:
            monnify(api_key=SECRET_KEY, secret_key=API_KEY, transport=Harness([]))
        self.assertIn("must begin MK_TEST_ or MK_PROD_", str(ctx.exception))

    def test_refuses_a_live_key_while_the_environment_says_test(self) -> None:
        with self.assertRaises(ConfigurationError):
            monnify(
                api_key="MK_PROD_EXAMPLEreal",
                secret_key=SECRET_KEY,
                environment="test",
                transport=Harness([]),
            )

    def test_refuses_a_test_key_while_the_environment_says_live(self) -> None:
        with self.assertRaises(ConfigurationError):
            monnify(
                api_key=API_KEY,
                secret_key=SECRET_KEY,
                environment="live",
                transport=Harness([]),
            )

    def test_warns_loudly_when_a_live_key_is_used_outside_production(self) -> None:
        warnings: list[str] = []
        monnify(
            api_key="MK_PROD_EXAMPLEreal",
            secret_key=SECRET_KEY,
            environment="live",
            transport=Harness([]),
            on_live_key_warning=warnings.append,
        )
        self.assertEqual(len(warnings), 1)
        self.assertIn("Real money will move", warnings[0])

    def test_the_sandbox_and_live_hosts_are_different_machines(self) -> None:
        # Unlike Paystack and Flutterwave v3, so a misconfigured test client cannot reach
        # live money. Asserted by observing the URL actually called.
        provider, harness = make(["banks-list"])
        provider.list_banks()
        self.assertTrue(harness.at(0).url.startswith("https://sandbox.monnify.com/"))


class TestAuthentication(unittest.TestCase):
    def test_exchanges_basic_credentials_for_a_bearer_token_first(self) -> None:
        provider, harness = make(["banks-list"])
        provider.list_banks()

        # Two calls: the login, then the request.
        self.assertEqual(len(harness.requests), 2)
        self.assertTrue(harness.at(0).url.endswith("/api/v1/auth/login"))
        self.assertEqual(harness.at(0).method, "POST")
        self.assertTrue(harness.at(0).headers["authorization"].startswith("Basic "))
        self.assertEqual(harness.at(1).headers["authorization"], "Bearer EXAMPLE.access.token")

    def test_the_basic_header_is_base64_of_api_key_and_secret(self) -> None:
        provider, harness = make(["banks-list"])
        provider.list_banks()
        expected = base64.b64encode(f"{API_KEY}:{SECRET_KEY}".encode()).decode("ascii")
        self.assertEqual(harness.at(0).headers["authorization"], f"Basic {expected}")

    def test_reuses_the_cached_token_rather_than_logging_in_again(self) -> None:
        provider, harness = make(["banks-list", "banks-list"])
        provider.list_banks()
        provider.list_banks()

        # Three calls, not four: one login shared by both requests.
        self.assertEqual(len(harness.requests), 3)
        self.assertEqual(harness.logins(), 1)

    def test_logs_in_again_once_the_token_has_expired(self) -> None:
        clock = [1_000_000.0]

        class Clock:
            def __init__(self) -> None:
                self.requests: list[TransportRequest] = []

            def send(self, request: TransportRequest) -> TransportResponse:
                self.requests.append(request)
                body = (
                    fixture("auth-login")
                    if request.url.endswith("/auth/login")
                    else fixture("banks-list")
                )
                return TransportResponse(
                    status=200,
                    headers={"content-type": "application/json"},
                    text=json.dumps(body),
                )

        transport = Clock()
        provider = monnify(
            api_key=API_KEY,
            secret_key=SECRET_KEY,
            environment="test",
            transport=transport,
            now=lambda: clock[0],
        )

        provider.list_banks()
        # The fixture's expiresIn is 3600 seconds, minus a minute of headroom.
        clock[0] += 3_600.0
        provider.list_banks()

        logins = [r for r in transport.requests if r.url.endswith("/auth/login")]
        self.assertEqual(len(logins), 2)

    def test_a_failed_login_raises_authentication_error(self) -> None:
        provider, _ = make(
            [(401, {"requestSuccessful": False, "responseCode": 99, "responseMessage": ""})],
            skip_login=True,
        )
        with self.assertRaises(AuthenticationError) as ctx:
            provider.list_banks()
        self.assertIn("login failed", str(ctx.exception))

    def test_a_401_on_a_safe_request_retries_once_with_a_fresh_token(self) -> None:
        provider, harness = make(
            [
                (401, {"requestSuccessful": False, "responseMessage": "Unauthorized"}),
                "auth-login",
                "banks-list",
            ]
        )
        banks = provider.list_banks()

        self.assertGreater(len(banks), 0)
        # login, failed call, login again, successful call.
        self.assertEqual(len(harness.requests), 4)
        self.assertEqual(harness.logins(), 2)

    def test_a_401_on_a_money_moving_request_is_not_retried(self) -> None:
        # The point of the safety taxonomy: a second attempt could pay twice.
        provider, harness = make(
            [(401, {"requestSuccessful": False, "responseMessage": "Unauthorized"})]
        )
        with self.assertRaises(AuthenticationError):
            provider.create_payout(
                amount=naira(1000),
                reference="payout-01HQ-EXAMPLE",
                narration="Payout",
                bank_code="044",
                account_number="0123456789",
                account_name="Ada Example",
            )
        # One login and one attempt. No second attempt.
        self.assertEqual(len(harness.requests), 2)


class TestCollections(unittest.TestCase):
    def test_creates_a_checkout_with_a_decimal_amount_in_major_units(self) -> None:
        provider, harness = make(["transaction-initialize"])
        checkout = provider.create_checkout(
            amount=naira(100),
            email="ada@example.com",
            reference="order-01HQ-EXAMPLE",
            name="Ada Example",
            channels=["card", "bank_transfer"],
        )

        body = harness.body(1)
        # 100 naira is 10000 kobo internally and must go out as 100, not 10000.
        self.assertEqual(body["amount"], 100)
        self.assertEqual(body["currencyCode"], "NGN")
        self.assertEqual(body["paymentMethods"], ["CARD", "ACCOUNT_TRANSFER"])
        self.assertTrue(checkout["checkout_url"].startswith("https://sandbox.sdk.monnify.com/"))
        self.assertEqual(checkout["reference"], "order-01HQ-EXAMPLE")

    def test_a_fractional_naira_amount_survives_the_conversion_exactly(self) -> None:
        provider, harness = make(["transaction-initialize"])
        provider.create_checkout(
            amount=money(500_050, "NGN"),
            email="ada@example.com",
            reference="order-01HQ-EXAMPLE",
        )
        # 500050 kobo is 5000.50 naira, not 5000.5000000001.
        self.assertEqual(harness.body(1)["amount"], 5000.5)

    def test_refuses_a_currency_monnify_does_not_support(self) -> None:
        provider, harness = make(["transaction-initialize"])
        with self.assertRaises(ValidationError) as ctx:
            provider.create_checkout(
                amount=money(1000, "USD"),
                email="ada@example.com",
                reference="order-01HQ-EXAMPLE",
            )
        self.assertIn("Nigerian acquirer", str(ctx.exception))
        # Nothing was sent: not even the login.
        self.assertEqual(len(harness.requests), 0)

    def test_refuses_a_channel_monnify_does_not_have_before_sending(self) -> None:
        provider, harness = make(["transaction-initialize"])
        with self.assertRaises(ValidationError) as ctx:
            provider.create_checkout(
                amount=naira(100),
                email="ada@example.com",
                reference="order-01HQ-EXAMPLE",
                channels=["qr", "apple_pay"],
            )
        self.assertIn("does not support the channel(s): qr, apple_pay", str(ctx.exception))
        self.assertEqual(len(harness.requests), 0)

    def test_requires_a_contract_code_and_says_where_to_find_it(self) -> None:
        provider = monnify(
            api_key=API_KEY,
            secret_key=SECRET_KEY,
            environment="test",
            transport=Harness([]),
        )
        with self.assertRaises(ConfigurationError) as ctx:
            provider.create_checkout(
                amount=naira(100),
                email="ada@example.com",
                reference="order-01HQ-EXAMPLE",
            )
        self.assertIn("contract_code is required", str(ctx.exception))

    def test_verify_percent_encodes_the_pipes_in_monnifys_own_reference(self) -> None:
        provider, harness = make(["transaction-verify-paid"])
        provider.verify_transaction("MNFY|67|20220725111957|000283")
        self.assertTrue(
            harness.at(1).url.endswith("/api/v2/transactions/MNFY%7C67%7C20220725111957%7C000283")
        )

    def test_verify_reads_monnifys_string_amounts_and_non_iso_date(self) -> None:
        provider, _ = make(["transaction-verify-paid"])
        transaction = provider.verify_transaction("MNFY|67|20220725111957|000283")

        self.assertEqual(transaction.status, "successful")
        # "100.00" as a string becomes 10000 kobo.
        assert transaction.amount is not None
        assert transaction.amount_paid is not None
        assert transaction.amount_settled is not None
        self.assertEqual(transaction.amount.amount, 10_000)
        self.assertEqual(transaction.amount_paid.amount, 10_000)
        self.assertEqual(transaction.amount_settled.amount, 9_000)
        self.assertEqual(transaction.channel, "card")
        # "25/07/2022 11:20:20 AM" -- day first, 12-hour clock, read as UTC.
        assert transaction.paid_at is not None
        self.assertEqual(transaction.paid_at.isoformat(), "2022-07-25T11:20:20+00:00")

    def test_the_fixture_really_does_carry_strings(self) -> None:
        body = fixture("transaction-verify-paid")["responseBody"]
        self.assertIsInstance(body["amountPaid"], str)
        self.assertEqual(body["paidOn"], "25/07/2022 11:20:20 AM")

    def test_your_own_reference_has_its_own_verify_route(self) -> None:
        provider, harness = make(["transaction-verify-paid"])
        transaction = provider.verify_transaction_by_reference("12-3---03--1kls0a--dkad")

        # The full payload, same as verifying by Monnify's reference -- not a search hit.
        self.assertEqual(transaction.status, "successful")
        assert transaction.amount is not None
        self.assertEqual(transaction.amount.amount, 10_000)
        url = harness.at(1).url
        self.assertIn("/api/v2/merchant/transactions/query?", url)
        self.assertIn("paymentReference=12-3---03--1kls0a--dkad", unquote(url))

    def test_a_reference_monnify_has_never_seen_is_a_not_found_error(self) -> None:
        provider, _ = make(
            [
                (
                    404,
                    {
                        "requestSuccessful": False,
                        "responseCode": 99,
                        "responseMessage": "Transaction not found",
                    },
                )
            ]
        )
        with self.assertRaises(NotFoundError):
            provider.verify_transaction_by_reference("nope-EXAMPLE")

    def test_a_spring_page_is_normalised_zero_based_with_has_more(self) -> None:
        provider, _ = make(["transaction-search"])
        page = provider.list_transactions(page=0, page_size=10)

        self.assertEqual(page.page, 0)
        self.assertEqual(page.page_size, 10)
        self.assertEqual(page.total, 1)
        self.assertEqual(page.has_more, False)
        self.assertEqual(len(page.items), 1)

    def test_the_search_endpoint_is_enveloped_after_all(self) -> None:
        # Monnify's own specification shows this one endpoint returning its page at the
        # TOP LEVEL, outside responseBody, and the adapter was built with a fallback for
        # exactly that. The live sandbox returns the ordinary envelope (verified
        # 2026-11-19, `npm run sandbox:monnify` question 3), so the fixture now matches
        # the sandbox and this test pins that. The document and the sandbox disagree; the
        # sandbox wins.
        body = fixture("transaction-search")
        self.assertIn("responseBody", body)
        self.assertIn("content", body["responseBody"])

    def test_an_envelope_less_page_is_still_read(self) -> None:
        # The fallback stays, because Monnify documents the envelope-less shape and may
        # yet serve it. Exercised directly rather than through a fixture, so re-recording
        # the fixture can never silently delete this coverage.
        provider, _ = make(
            [
                (
                    200,
                    {
                        "content": [
                            {
                                "paymentReference": "bare-EXAMPLE",
                                "transactionReference": "MNFY|13|bare",
                                "paymentStatus": "PAID",
                                "amount": 50.0,
                                "currencyCode": "NGN",
                            }
                        ],
                        "totalElements": 1,
                        "totalPages": 1,
                        "last": True,
                        "size": 10,
                        "number": 0,
                    },
                )
            ]
        )
        page = provider.list_transactions(page=0, page_size=10)
        self.assertEqual(len(page.items), 1)
        self.assertEqual(page.items[0].reference, "bare-EXAMPLE")
        self.assertEqual(page.total, 1)

    def test_a_searched_row_claims_no_channel_and_no_amount_paid(self) -> None:
        # A search row carries `amount` and no `totalPayable`/`amountPaid`, and names
        # `collectionChannel` (how it was collected) rather than a payment method. The
        # adapter reports neither as the channel, because neither is Monnify's claim
        # about which instrument was used.
        provider, _ = make(["transaction-search"])
        row = provider.list_transactions(page=0, page_size=10).items[0]

        self.assertIsNone(row.channel)
        self.assertIsNone(row.amount_paid)
        self.assertIsNone(row.amount_settled)
        self.assertIsNotNone(row.amount)


class TestTheEnvelope(unittest.TestCase):
    def test_request_successful_false_with_http_200_is_a_failure(self) -> None:
        # The trap: reading the HTTP status alone would return this as a transaction.
        provider, _ = make(
            [
                (
                    200,
                    {
                        "requestSuccessful": False,
                        "responseCode": 99,
                        "responseMessage": "Duplicate payment reference",
                    },
                )
            ]
        )
        with self.assertRaises(DuplicateReferenceError):
            provider.create_checkout(
                amount=naira(100),
                email="ada@example.com",
                reference="order-01HQ-EXAMPLE",
            )

    def test_a_gated_feature_reads_as_configuration_not_authentication(self) -> None:
        provider, _ = make(
            [
                (
                    400,
                    {
                        "requestSuccessful": False,
                        "responseCode": 99,
                        "responseMessage": "Merchant is not enabled for disbursements",
                    },
                )
            ]
        )
        with self.assertRaises(ConfigurationError) as ctx:
            provider.get_payout("payout-01HQ-EXAMPLE")
        self.assertIn("relationship manager", str(ctx.exception))

    def test_response_code_is_carried_through_as_a_string(self) -> None:
        provider, _ = make(
            [(400, {"requestSuccessful": False, "responseCode": 99, "responseMessage": "no"})]
        )
        with self.assertRaises(Exception) as ctx:
            provider.list_banks()
        self.assertEqual(getattr(ctx.exception, "provider_code", None), "99")


class TestVirtualAccounts(unittest.TestCase):
    def test_creates_a_reserved_account_at_every_partner_bank(self) -> None:
        provider, harness = make(["reserved-account-create"])
        account = provider.create_virtual_account(
            reference="va-ada-EXAMPLE",
            account_name="Ada Example",
            customer_email="ada@example.com",
            customer_name="Ada Example",
            bvn="21212121212",
            all_banks=True,
        )

        body = harness.body(1)
        self.assertEqual(body["getAllAvailableBanks"], True)
        # Monnify's own default is true, which would reject the inflows you are waiting
        # for.
        self.assertEqual(body["restrictPaymentSource"], False)
        self.assertGreaterEqual(len(account.accounts), 1)
        self.assertEqual(account.accounts[0].provider, "monnify")

    def test_a_reserved_account_needs_a_bvn_or_a_nin(self) -> None:
        provider, harness = make(["reserved-account-create"])
        with self.assertRaises(KycRequiredError) as ctx:
            provider.create_virtual_account(
                reference="va-ada-EXAMPLE",
                account_name="Ada Example",
                customer_email="ada@example.com",
                customer_name="Ada Example",
            )
        self.assertEqual(list(ctx.exception.required), ["bvn"])
        self.assertEqual(len(harness.requests), 0)

    def test_restrict_payment_source_is_only_true_with_an_allow_list(self) -> None:
        provider, harness = make(["reserved-account-create"])
        provider.create_virtual_account(
            reference="va-ada-EXAMPLE",
            account_name="Ada Example",
            customer_email="ada@example.com",
            customer_name="Ada Example",
            bvn="21212121212",
            allowed_sources={"bvns": ["21212121212"]},
        )
        body = harness.body(1)
        self.assertEqual(body["restrictPaymentSource"], True)
        self.assertEqual(body["allowedPaymentSources"]["bvns"], ["21212121212"])

    def test_naming_no_bank_and_not_asking_for_all_banks_fails_locally(self) -> None:
        provider, harness = make(["reserved-account-create"])
        with self.assertRaises(ValidationError) as ctx:
            provider.create_virtual_account(
                reference="va-ada-EXAMPLE",
                account_name="Ada Example",
                customer_email="ada@example.com",
                customer_name="Ada Example",
                bvn="21212121212",
                all_banks=False,
                preferred_bank_codes=[],
            )
        self.assertIn("either set all_banks, or name at least one", str(ctx.exception))
        self.assertEqual(len(harness.requests), 0)

    def test_a_kyc_status_is_never_reported_as_verified(self) -> None:
        provider, _ = make(["reserved-account-create"])
        account = provider.create_virtual_account(
            reference="va-ada-EXAMPLE",
            account_name="Ada Example",
            customer_email="ada@example.com",
            customer_name="Ada Example",
            bvn="21212121212",
        )
        # Monnify echoes the BVN it was given and passes no verdict on it.
        self.assertEqual(account.kyc_status, "pending")

    def test_the_bvn_route_takes_a_bvn_alone_and_the_kyc_route_demands_both(self) -> None:
        provider, harness = make(["reserved-account-update-bvn"])
        provider.update_virtual_account_bvn(reference="va-ada-EXAMPLE", bvn="21212121212")

        self.assertEqual(harness.at(1).method, "PUT")
        self.assertTrue(harness.at(1).url.endswith("update-customer-bvn/va-ada-EXAMPLE"))
        self.assertEqual(harness.body(1), {"bvn": "21212121212"})

        with self.assertRaises(ValidationError) as ctx:
            provider.update_virtual_account_kyc(reference="va-ada-EXAMPLE", bvn="2", nin="")
        self.assertIn("requires BOTH a bvn and a nin", str(ctx.exception))

    def test_deallocation_is_a_delete_and_there_is_no_undo(self) -> None:
        provider, harness = make(["reserved-account-get"])
        provider.deactivate_virtual_account("va-ada-EXAMPLE")

        self.assertEqual(harness.at(1).method, "DELETE")
        self.assertTrue(harness.at(1).url.endswith("reserved-accounts/reference/va-ada-EXAMPLE"))
        # Flutterwave can reactivate; Monnify cannot, so no such method exists here.
        self.assertFalse(hasattr(provider, "reactivate_virtual_account"))

    def test_inflows_require_the_account_reference_as_a_query_parameter(self) -> None:
        provider, harness = make(["reserved-account-transactions"])
        page = provider.list_virtual_account_inflows(reference="va-ada-EXAMPLE")
        self.assertIn("accountReference=va-ada-EXAMPLE", harness.at(1).url)
        self.assertGreaterEqual(len(page.items), 0)


class TestSplits(unittest.TestCase):
    def test_basis_points_become_monnifys_percentages(self) -> None:
        provider, harness = make(["transaction-initialize"])
        provider.create_checkout(
            amount=naira(100),
            email="ada@example.com",
            reference="order-01HQ-EXAMPLE",
            splits=[
                {
                    "sub_account_code": "MFY_SUB_EXAMPLE",
                    "share_basis_points": 2000,
                    "bears_fee": True,
                }
            ],
        )

        entry = harness.body(1)["incomeSplitConfig"][0]
        # 2000 basis points is 20%, which Monnify spells as 20.
        self.assertEqual(entry["splitPercentage"], 20)
        self.assertEqual(entry["feeBearer"], True)

    def test_a_share_that_is_not_whole_basis_points_is_refused(self) -> None:
        provider, _ = make(["transaction-initialize"])
        with self.assertRaises(ValidationError) as ctx:
            provider.create_checkout(
                amount=naira(100),
                email="ada@example.com",
                reference="order-01HQ-EXAMPLE",
                splits=[{"sub_account_code": "MFY_SUB_EXAMPLE", "share_basis_points": 20.5}],
            )
        self.assertIn("whole basis points", str(ctx.exception))

    def test_a_split_entry_with_no_share_at_all_is_refused(self) -> None:
        provider, _ = make(["transaction-initialize"])
        with self.assertRaises(ValidationError) as ctx:
            provider.create_split([{"sub_account_code": "MFY_SUB_EXAMPLE"}])
        self.assertIn("needs either share_basis_points or share_amount", str(ctx.exception))

    def test_create_split_makes_no_network_call(self) -> None:
        provider, harness = make([])
        split = provider.create_split(
            [{"sub_account_code": "MFY_SUB_EXAMPLE", "share_basis_points": 1000}]
        )
        self.assertEqual(len(split), 1)
        self.assertEqual(len(harness.requests), 0)

    def test_sub_accounts_are_created_from_an_array_and_come_back_as_an_array(self) -> None:
        provider, harness = make(["sub-account-create"])
        accounts = provider.create_split_accounts(
            [
                {
                    "account_number": "0123456789",
                    "bank_code": "044",
                    "email": "ada@example.com",
                    "default_share_basis_points": 2000,
                }
            ]
        )

        self.assertIsInstance(harness.body(1), list)
        self.assertEqual(len(accounts), 1)
        # What comes back is Monnify's own 20.87%, not the 20% we asked for: the
        # response, not the request, is the truth about a sub-account's default share.
        self.assertEqual(accounts[0].default_share_basis_points, 2087)

    def test_the_income_split_config_update_sends_a_bare_array(self) -> None:
        provider, harness = make([(200, {"requestSuccessful": True})])
        provider.update_virtual_account_splits(
            reference="va-ada-EXAMPLE",
            splits=[{"sub_account_code": "MFY_SUB_EXAMPLE", "share_basis_points": 1500}],
        )
        # The one endpoint in the Monnify API whose body is an array, not an object.
        self.assertIsInstance(harness.body(1), list)


class TestPayouts(unittest.TestCase):
    def test_a_created_transfer_awaiting_an_otp_is_pending_not_sent(self) -> None:
        # The single most dangerous response in this API to misread: requestSuccessful is
        # true, the HTTP status is 200, and no money has moved.
        provider, _ = make(["transfer-single-pending-authorization"])
        payout = provider.create_payout(
            amount=naira(1000),
            reference="payout-01HQ-EXAMPLE",
            narration="Payout",
            bank_code="044",
            account_number="0123456789",
            account_name="Ada Example",
        )

        self.assertEqual(payout.status, "pending")
        self.assertEqual(payout.awaiting_otp, True)

    def test_the_fixture_really_says_pending_authorization(self) -> None:
        response = fixture("transfer-single-pending-authorization")
        self.assertEqual(response["responseBody"]["status"], "PENDING_AUTHORIZATION")
        # And the envelope says it succeeded at the same time.
        self.assertEqual(response["requestSuccessful"], True)

    def test_otp_email_dispatch_failed_is_also_pending(self) -> None:
        self.assertEqual(normalise_transfer_status("OTP_EMAIL_DISPATCH_FAILED"), "pending")

    def test_a_payout_needs_the_wallet_account_number_and_says_why(self) -> None:
        provider = monnify(
            api_key=API_KEY,
            secret_key=SECRET_KEY,
            contract_code=CONTRACT_CODE,
            environment="test",
            transport=Harness([]),
        )
        with self.assertRaises(ConfigurationError) as ctx:
            provider.create_payout(
                amount=naira(1000),
                reference="payout-01HQ-EXAMPLE",
                narration="Payout",
                bank_code="044",
                account_number="0123456789",
                account_name="Ada Example",
            )
        self.assertIn("wallet_account_number is required", str(ctx.exception))

    def test_a_payout_is_never_retried_and_a_503_reports_an_unknown_outcome(self) -> None:
        provider, harness = make(
            [(503, {"requestSuccessful": False, "responseMessage": "Service unavailable"})]
        )
        with self.assertRaises(PayoutStatusUnknownError) as ctx:
            provider.create_payout(
                amount=naira(1000),
                reference="payout-01HQ-EXAMPLE",
                narration="Payout",
                bank_code="044",
                account_number="0123456789",
                account_name="Ada Example",
            )
        # Not ProviderDownError: the transfer may have been accepted, so the outcome is
        # genuinely unknown and must be queried rather than retried.
        self.assertIn("must NOT be retried", str(ctx.exception))
        # The login plus exactly one attempt.
        self.assertEqual(len(harness.requests), 2)

    def test_authorising_a_payout_submits_the_otp_as_authorization_code(self) -> None:
        provider, harness = make(["transfer-single-summary"])
        provider.authorize_payout(reference="payout-01HQ-EXAMPLE", otp="123456")

        self.assertTrue(harness.at(1).url.endswith("/api/v2/disbursements/single/validate-otp"))
        self.assertEqual(
            harness.body(1),
            {"reference": "payout-01HQ-EXAMPLE", "authorizationCode": "123456"},
        )

    def test_a_batch_defaults_to_break(self) -> None:
        provider, harness = make(["transfer-batch"])
        batch = provider.create_bulk_payout(
            batch_reference="batch-01HQ-EXAMPLE",
            narration="Payroll",
            transfers=[
                {
                    "amount": naira(1000),
                    "reference": "payout-01HQ-EXAMPLE-1",
                    "narration": "Payroll",
                    "bank_code": "044",
                    "account_number": "0123456789",
                }
            ],
        )

        body = harness.body(1)
        self.assertEqual(body["onValidationFailure"], "BREAK")
        # The spec's required list names `title`, even though its schema omits it.
        self.assertEqual(body["title"], "Payroll")
        self.assertGreater(len(batch.batch_reference), 0)

    def test_an_empty_batch_is_refused_locally(self) -> None:
        provider, harness = make(["transfer-batch"])
        with self.assertRaises(ValidationError) as ctx:
            provider.create_bulk_payout(
                batch_reference="batch-01HQ-EXAMPLE",
                narration="Payroll",
                transfers=[],
            )
        self.assertIn("at least one transfer", str(ctx.exception))
        self.assertEqual(len(harness.requests), 0)

    def test_the_batch_otp_field_is_reference_not_batch_reference(self) -> None:
        provider, harness = make(["transfer-batch"])
        provider.authorize_bulk_payout(batch_reference="batch-01HQ-EXAMPLE", otp="123456")
        self.assertEqual(
            harness.body(1),
            {"reference": "batch-01HQ-EXAMPLE", "authorizationCode": "123456"},
        )

    def test_listing_payouts_uses_page_no_and_page_size(self) -> None:
        # Monnify is not consistent between its own endpoints, and guessing wrong
        # silently returns the first page every time.
        provider, harness = make(
            [(200, {"requestSuccessful": True, "responseBody": {"content": []}})]
        )
        provider.list_payouts(page=2, page_size=50)
        self.assertIn("pageNo=2", harness.at(1).url)
        self.assertIn("pageSize=50", harness.at(1).url)


class TestBanksBalanceAndNameEnquiry(unittest.TestCase):
    def test_banks_carry_monnifys_ussd_templates_nulls_included(self) -> None:
        provider, _ = make(["banks-list"])
        banks = provider.list_banks()

        self.assertGreaterEqual(len(banks), 3)
        access = next(bank for bank in banks if bank.code == "044")
        self.assertEqual(access.ussd_template, "*901*Amount*AccountNumber#")
        # Several banks genuinely have none, and that is carried as None, not "".
        other = next(bank for bank in banks if bank.code == "50515")
        self.assertIsNone(other.ussd_template)

    def test_name_enquiry_enriches_without_changing_the_providers_code(self) -> None:
        provider, _ = make(["account-validate"])
        account = provider.resolve_account(account_number="0123456789", bank_code="044")

        # The response's own bankCode wins, even where it differs from the one we asked
        # about: enrichment never rewrites what the provider said.
        self.assertEqual(account.bank_code, "057")
        self.assertEqual(account.provider, "monnify")
        self.assertIsNotNone(account.institution)

    def test_the_balance_comes_back_as_integer_minor_units(self) -> None:
        provider, harness = make(["wallet-balance"])
        balance = provider.get_balance()

        self.assertIn("accountNumber=3934178936", harness.at(1).url)
        self.assertEqual(balance.account_number, WALLET)
        # Monnify sends these as decimal strings.
        assert balance.available is not None
        self.assertGreater(balance.available.amount, 0)


class TestRefunds(unittest.TestCase):
    def test_a_refund_sends_both_required_notes(self) -> None:
        provider, harness = make(["refund-initiate"])
        provider.create_refund(
            transaction_reference="MNFY|67|20220725111957|000283",
            amount=naira(100),
            reference="refund-01HQ-EXAMPLE",
            reason="Duplicate order",
            customer_note="Refund for duplicate order",
        )

        body = harness.body(1)
        self.assertEqual(body["refundAmount"], 100)
        self.assertEqual(body["refundReason"], "Duplicate order")
        self.assertEqual(body["customerNote"], "Refund for duplicate order")

    def test_the_refund_status_path_takes_the_refund_reference(self) -> None:
        # Monnify's own OpenAPI document spells this path key as
        # /api/v1/refunds/202100op3456, with a literal example value baked into it.
        # Copying the key would 404 on every refund but one.
        provider, harness = make(["refund-initiate"])
        provider.get_refund("refund-01HQ-EXAMPLE")
        self.assertTrue(harness.at(1).url.endswith("/api/v1/refunds/refund-01HQ-EXAMPLE"))
        self.assertNotIn("202100op3456", harness.at(1).url)


class TestWebhooks(unittest.TestCase):
    def test_reproduces_monnifys_own_published_hash(self) -> None:
        # The vector that settles the contradiction on Monnify's webhook page: its prose
        # says SHA-512(secret + body) and its three code samples say HMAC. Monnify also
        # publishes a secret, a payload and the expected hash -- and only the HMAC
        # reproduces it.
        published = json.loads(fixture_file("webhook-successful-transaction", "published.json"))
        computed = compute_signature(
            scheme=SCHEMES["monnify"],
            body=published["body"].encode("utf-8"),
            secret=published["secret"],
        )
        self.assertEqual(computed, published["signature"])

    def test_the_plain_digest_its_prose_describes_does_not_reproduce_it(self) -> None:
        # Recorded so nobody "fixes" the implementation towards the prose later.
        published = json.loads(fixture_file("webhook-successful-transaction", "published.json"))
        digest = hashlib.sha512(
            (published["secret"] + published["body"]).encode("utf-8")
        ).hexdigest()
        self.assertNotEqual(digest, published["signature"])

    def test_verifies_a_signed_webhook_over_the_raw_bytes(self) -> None:
        provider, _ = make([])
        body = fixture_file("webhook-successful-transaction", "body.json").encode("utf-8")
        signature = compute_signature(scheme=SCHEMES["monnify"], body=body, secret=SECRET_KEY)

        result = provider.verify_webhook(body=body, headers={"Monnify-Signature": signature})
        self.assertEqual(result.verified, True)
        self.assertEqual(result.strength, "full-body")

    def test_a_tampered_body_does_not_verify(self) -> None:
        provider, _ = make([])
        text = fixture_file("webhook-successful-transaction", "body.json")
        signature = compute_signature(
            scheme=SCHEMES["monnify"], body=text.encode("utf-8"), secret=SECRET_KEY
        )

        result = provider.verify_webhook(
            body=text.replace("78000", "7800000").encode("utf-8"),
            headers={"monnify-signature": signature},
        )
        self.assertEqual(result.verified, False)

    def test_a_sandbox_delivery_with_no_header_is_reported_honestly(self) -> None:
        # Monnify documents that the header is only sent in production. Saying so in the
        # reason is the whole value of this path.
        provider, _ = make([])
        result = provider.verify_webhook(body=b"{}", headers={})
        self.assertEqual(result.verified, False)
        self.assertEqual(result.strength, "unverified")
        self.assertIn("only sent on production notifications", result.reason or "")

    def test_the_published_webhook_ip_is_recognised_and_others_are_not(self) -> None:
        provider, _ = make([])
        self.assertTrue(provider.is_known_webhook_ip("35.242.133.146"))
        self.assertTrue(provider.is_known_webhook_ip(" 35.242.133.146 "))
        self.assertFalse(provider.is_known_webhook_ip("35.242.133.147"))


class TestNormalisation(unittest.TestCase):
    def test_partially_paid_is_pending_and_overpaid_is_successful(self) -> None:
        # The most expensive mistake this file could make would be reporting a partial
        # payment as successful.
        self.assertEqual(normalise_status("PARTIALLY_PAID"), "pending")
        self.assertEqual(normalise_status("OVERPAID"), "successful")
        self.assertEqual(normalise_status("PAID"), "successful")

    def test_an_unknown_status_is_pending_which_is_the_safe_direction(self) -> None:
        self.assertEqual(normalise_status("SOMETHING_NEW"), "pending")
        self.assertEqual(normalise_status(None), "pending")
        self.assertEqual(normalise_transfer_status("SOMETHING_NEW"), "pending")

    def test_midnight_and_midday_are_parsed_correctly(self) -> None:
        # 12 AM is hour 0 and 12 PM is hour 12; adding twelve for PM gets both wrong.
        midnight = parse_monnify_date("25/07/2022 12:00:00 AM")
        midday = parse_monnify_date("25/07/2022 12:00:00 PM")
        assert midnight is not None and midday is not None
        self.assertEqual(midnight.isoformat(), "2022-07-25T00:00:00+00:00")
        self.assertEqual(midday.isoformat(), "2022-07-25T12:00:00+00:00")

    def test_an_impossible_date_is_refused_rather_than_rolled_forward(self) -> None:
        self.assertIsNone(parse_monnify_date("31/02/2022 10:00:00 AM"))
        self.assertIsNone(parse_monnify_date("not a date"))

    def test_a_zoneless_stamp_is_read_as_utc_in_both_languages(self) -> None:
        # JavaScript would otherwise read it as local time and Python as naive, so the
        # two packages would disagree about the instant. See the parity cases.
        parsed = parse_monnify_date("2024-11-25 07:35:17.566")
        assert parsed is not None
        self.assertEqual(parsed.isoformat(), "2024-11-25T07:35:17.566000+00:00")

    def test_an_amount_that_cannot_be_represented_exactly_is_none(self) -> None:
        exact = as_money("100.00")
        whole = as_money(100)
        assert exact is not None and whole is not None
        self.assertEqual(exact.amount, 10_000)
        self.assertEqual(whole.amount, 10_000)
        # Three decimal places in a two-decimal currency.
        self.assertIsNone(as_money("100.001"))
        self.assertIsNone(as_money("not a number"))
        self.assertIsNone(as_money(-1))

    def test_the_payers_own_account_is_carried_through(self) -> None:
        transaction = to_transaction(
            {
                "paymentReference": "order-01HQ-EXAMPLE",
                "paymentStatus": "PAID",
                "amountPaid": "100.00",
                "paymentSourceInformation": [
                    {
                        "accountNumber": "0123456789",
                        "bankCode": "044",
                        "accountName": "ADA EXAMPLE",
                    }
                ],
            }
        )
        # An array on a webhook, an object on a verify response. Both shapes accepted.
        assert transaction.source_account is not None
        self.assertEqual(transaction.source_account.account_number, "0123456789")
        self.assertEqual(transaction.source_account.bank_code, "044")


class TestCapabilities(unittest.TestCase):
    def test_an_unsupported_operation_is_declared_as_such(self) -> None:
        provider, harness = make([])
        # Monnify's sub-accounts are settlement destinations, not spendable wallets.
        self.assertFalse(supports(provider.capabilities, "wallets.open"))
        self.assertEqual(len(harness.requests), 0)

    def test_the_operations_monnify_gates_behind_approval_are_declared(self) -> None:
        provider, _ = make([])
        gated = operations_requiring_approval(provider.capabilities)
        # Monnify's own spec says so for all three groups.
        self.assertIn("payouts.create", gated)
        self.assertIn("splitAccounts.create", gated)
        self.assertIn("refunds.create", gated)

    def test_the_webhook_strength_is_claimed_as_full_body(self) -> None:
        provider, _ = make([])
        signature = provider.capabilities.webhook_signature
        assert signature is not None
        self.assertEqual(signature.strength, "full-body")
        self.assertIn("only sent in production", signature.notes or "")

    def test_what_is_not_implemented_says_why(self) -> None:
        provider, _ = make([])
        self.assertIn(
            "not spendable customer wallets", provider.not_yet_implemented["wallets.open"]
        )
        self.assertIn("Milestone 7", provider.not_yet_implemented["mandates.create"])

    def test_the_provider_is_the_class_it_claims_to_be(self) -> None:
        provider, _ = make([])
        self.assertIsInstance(provider, MonnifyProvider)
        self.assertEqual(provider.name, "monnify")


if __name__ == "__main__":
    unittest.main()
