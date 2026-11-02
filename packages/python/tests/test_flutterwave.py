"""Flutterwave adapter tests, mirroring packages/ts/test/flutterwave.test.ts.

Everything runs against the recorded fixtures in fixtures/providers/flutterwave/ through
a fake transport, so there is no network and no keys.
"""

import copy
import json
import pathlib
import sys
import unittest
from typing import Any

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "src"))

from naija_pay.core.capabilities import operations_not_sandbox_verified, supports
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
from naija_pay.providers.flutterwave import flutterwave

FIXTURES = pathlib.Path(__file__).resolve().parents[3] / "fixtures" / "providers" / "flutterwave"
TEST_KEY = "FLWSECK_TEST-EXAMPLEflutterwave-X"
WEBHOOK_HASH = "EXAMPLE-secret-hash"


def fixture(operation: str) -> dict[str, Any]:
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

    def body(self, index: int) -> dict[str, Any]:
        raw = self.requests[index].body
        return json.loads(raw) if raw else {}


def make(steps: list[Any], **extra: Any) -> tuple[Any, Harness]:
    harness = Harness(steps)
    provider = flutterwave(
        secret_key=TEST_KEY,
        webhook_secret_hash=WEBHOOK_HASH,
        environment="test",
        transport=harness,
        sleep=lambda _seconds: None,
        **extra,
    )
    return provider, harness


class TestConstructionAndKeySafety(unittest.TestCase):
    def test_accepts_test_key(self) -> None:
        provider, _ = make(["payment-initialize"])
        self.assertEqual(provider.name, "flutterwave")

    def test_refuses_live_key_in_test_environment(self) -> None:
        # The check that matters most: v3 serves test and live from one host, so nothing
        # else would catch this before real money moved.
        with self.assertRaises(ConfigurationError) as ctx:
            flutterwave(
                secret_key="FLWSECK-EXAMPLEreal-X",
                environment="test",
                transport=Harness([]),
            )
        self.assertIn("LIVE secret key", str(ctx.exception))
        self.assertIn("same host", str(ctx.exception))

    def test_refuses_test_key_in_live_environment(self) -> None:
        with self.assertRaises(ConfigurationError):
            flutterwave(secret_key=TEST_KEY, environment="live", transport=Harness([]))

    def test_refuses_public_key(self) -> None:
        with self.assertRaises(ConfigurationError) as ctx:
            flutterwave(
                secret_key="FLWPUBK_TEST-EXAMPLEpublic-X",
                environment="test",
                transport=Harness([]),
            )
        self.assertIn("FLWPUBK", str(ctx.exception))

    def test_refuses_v4_client_secret_naming_the_version_it_speaks(self) -> None:
        # Someone holding v4 credentials should be told why they do not work here, not
        # left with an authentication failure from the provider.
        with self.assertRaises(ConfigurationError) as ctx:
            flutterwave(
                secret_key="EXAMPLE-v4-client-secret",
                environment="test",
                transport=Harness([]),
            )
        self.assertIn("v4 OAuth client secret is not a v3 key", str(ctx.exception))

    def test_refuses_empty_key(self) -> None:
        with self.assertRaises(ConfigurationError):
            flutterwave(secret_key="  ", transport=Harness([]))


class TestDecimalAmounts(unittest.TestCase):
    """Amounts are decimal on the wire and integer minor units in the API."""

    def test_checkout_sends_major_units_not_kobo(self) -> None:
        provider, harness = make(["payment-initialize"])
        provider.create_checkout(
            amount=naira(5000), email="ada@example.com", reference="order-01HQ-EXAMPLE"
        )
        # The whole point: 5,000 naira is 500000 kobo internally and 5000 on the wire.
        # Sending the kobo figure would charge a hundred times too much.
        self.assertEqual(harness.body(0)["amount"], 5000)
        self.assertNotEqual(harness.body(0)["amount"], 500_000)

    def test_fractional_amount_survives_round_trip(self) -> None:
        provider, harness = make(["payment-initialize"])
        # 20,000.50 naira. A naive conversion is where the stray kobo disappears.
        provider.create_checkout(
            amount=money(2_000_050, "NGN"),
            email="ada@example.com",
            reference="order-01HR-EXAMPLE",
        )
        self.assertEqual(harness.body(0)["amount"], 20_000.5)

    def test_decimal_balance_becomes_exact_minor_units(self) -> None:
        provider, _ = make(["balances-get"])
        balances = provider.get_balance()
        # 20000.5 is 2,000,050 kobo. 3.29 USD is 329 cents, and a plain multiply by 100
        # gives 328.99999999999994 -- the case that forced the round-trip assertion.
        self.assertEqual(
            list(balances),
            [
                {"amount": 2_000_050, "currency": "NGN"},
                {"amount": 329, "currency": "USD"},
            ],
        )

    def test_verified_transaction_keeps_the_three_amounts_apart(self) -> None:
        provider, _ = make(["transaction-verify-success"])
        transaction = provider.verify_transaction(288_200_108)

        self.assertEqual(transaction.status, "successful")
        self.assertEqual(transaction.amount, money(500_000, "NGN"))
        self.assertEqual(transaction.amount_paid, money(500_000, "NGN"))
        self.assertEqual(transaction.fees, money(7_000, "NGN"))
        # 4930.0 settled out of 5000 charged: the fee came off.
        self.assertEqual(transaction.amount_settled, money(493_000, "NGN"))


class TestCollections(unittest.TestCase):
    def test_returns_hosted_link(self) -> None:
        provider, harness = make(["payment-initialize"])
        checkout = provider.create_checkout(
            amount=naira(5000),
            email="ada@example.com",
            reference="order-01HQ-EXAMPLE",
            channels=["card", "bank_transfer"],
        )
        self.assertTrue(checkout["checkout_url"].startswith("https://checkout.flutterwave.com/"))
        self.assertEqual(checkout["reference"], "order-01HQ-EXAMPLE")
        self.assertEqual(harness.requests[0].method, "POST")
        self.assertTrue(harness.requests[0].url.endswith("/v3/payments"))

    def test_channels_go_as_comma_separated_string(self) -> None:
        provider, harness = make(["payment-initialize"])
        provider.create_checkout(
            amount=naira(5000),
            email="ada@example.com",
            reference="order-01HQ-EXAMPLE",
            channels=["card", "bank_transfer", "ussd"],
        )
        # Flutterwave ignores an array here, which silently offers every channel instead
        # of the ones that were asked for.
        self.assertEqual(harness.body(0)["payment_options"], "card,banktransfer,ussd")

    def test_refuses_unsupported_channel(self) -> None:
        provider, harness = make(["payment-initialize"])
        with self.assertRaises(ValidationError) as ctx:
            provider.create_checkout(
                amount=naira(5000),
                email="ada@example.com",
                reference="order-01HQ-EXAMPLE",
                channels=["google_pay"],
            )
        self.assertIn("google_pay", str(ctx.exception))
        self.assertEqual(len(harness.requests), 0)

    def test_refuses_reference_v4_would_reject(self) -> None:
        provider, harness = make(["payment-initialize"])
        with self.assertRaises(ValidationError) as ctx:
            # Underscores are fine in v3 and rejected by v4's pattern.
            provider.create_checkout(
                amount=naira(5000), email="ada@example.com", reference="order_01HQ"
            )
        self.assertIn("letters, digits and hyphens", str(ctx.exception))
        self.assertEqual(len(harness.requests), 0)

    def test_pending_transaction_is_never_reported_as_paid(self) -> None:
        provider, _ = make(["transaction-verify-pending"])
        transaction = provider.verify_transaction(288_200_109)
        self.assertEqual(transaction.status, "pending")
        self.assertIsNone(transaction.paid_at)

    def test_verify_by_reference_uses_the_by_reference_route(self) -> None:
        provider, harness = make(["transaction-verify-success"])
        provider.verify_transaction_by_reference("order-01HQ-EXAMPLE")
        self.assertIn("verify_by_reference", harness.requests[0].url)
        self.assertIn("tx_ref=order-01HQ-EXAMPLE", harness.requests[0].url)

    def test_refund_sends_major_units_and_normalises_status(self) -> None:
        provider, harness = make(["transaction-refund"])
        refund = provider.create_refund(transaction_id=288_200_108, amount=naira(2000))
        self.assertEqual(harness.body(0)["amount"], 2000)
        self.assertEqual(refund.status, "processed")
        self.assertEqual(refund.amount, money(200_000, "NGN"))


class TestPayouts(unittest.TestCase):
    def test_queued_transfer_is_pending_not_successful(self) -> None:
        provider, _ = make(["transfer-create"])
        payout = provider.create_payout(
            amount=naira(5000),
            account_number="0690000037",
            bank_code="044",
            reference="payout-01hq-example",
        )
        # The envelope says "status": "success" and "Transfer Queued Successfully" while
        # data.status says "NEW". Reading the envelope marks every payout as paid the
        # instant Flutterwave accepts it.
        self.assertEqual(payout.status, "pending")
        self.assertFalse(payout.awaiting_approval)
        self.assertFalse(payout.awaiting_otp)
        self.assertEqual(payout.amount, money(500_000, "NGN"))
        self.assertEqual(payout.fee, money(4_500, "NGN"))

    def test_the_fixture_really_does_say_new(self) -> None:
        # So the test above is not tautological.
        body = fixture("transfer-create")
        self.assertEqual(body["status"], "success")
        self.assertEqual(body["data"]["status"], "NEW")

    def test_transfer_awaiting_dashboard_approval_says_so(self) -> None:
        gated = copy.deepcopy(fixture("transfer-create"))
        gated["data"]["requires_approval"] = 1
        gated["data"]["is_approved"] = 0

        provider, _ = make([(200, gated)])
        payout = provider.create_payout(
            amount=naira(5000),
            account_number="0690000037",
            bank_code="044",
            reference="payout-01hq-example",
        )
        self.assertTrue(payout.awaiting_approval)
        self.assertEqual(payout.status, "pending")

    def test_money_moving_transfer_is_not_retried(self) -> None:
        provider, harness = make([(503, {"status": "error", "message": "Service unavailable"})])
        # Not ProviderDownError: a money-moving request whose outcome is unknown gets
        # its own type, because the one thing an application must not do is retry it.
        with self.assertRaises(PayoutStatusUnknownError) as ctx:
            provider.create_payout(
                amount=naira(5000),
                account_number="0690000037",
                bank_code="044",
                reference="payout-01hq-example",
            )
        self.assertIn("must NOT be retried", str(ctx.exception))
        # Exactly one attempt: a retried payout can pay twice.
        self.assertEqual(len(harness.requests), 1)

    def test_duplicate_reference_is_typed(self) -> None:
        provider, _ = make([(400, fixture("error-duplicate-reference"))])
        with self.assertRaises(DuplicateReferenceError):
            provider.create_payout(
                amount=naira(5000),
                account_number="0690000037",
                bank_code="044",
                reference="payout-01hq-example",
            )

    def test_empty_balance_is_typed_on_flutterwaves_own_wording(self) -> None:
        provider, _ = make([(400, fixture("error-insufficient-funds"))])
        with self.assertRaises(InsufficientFundsError):
            provider.create_payout(
                amount=naira(500_000),
                account_number="0690000037",
                bank_code="044",
                reference="payout-01hr-example",
            )

    def test_status_error_inside_a_200_is_still_a_failure(self) -> None:
        # v3 does this, and treating a 200 as success without reading the envelope is how
        # a duplicate payout gets reported as sent.
        provider, _ = make(
            [(200, {"status": "error", "message": "Transfer reference is used already"})]
        )
        with self.assertRaises(DuplicateReferenceError):
            provider.create_payout(
                amount=naira(5000),
                account_number="0690000037",
                bank_code="044",
                reference="payout-01hq-example",
            )

    def test_resolving_an_account_carries_the_bank_code_through(self) -> None:
        provider, _ = make(["accounts-resolve"])
        account = provider.resolve_account(account_number="0690000032", bank_code="044")
        # Flutterwave's response omits the bank code, so without carrying it the enriched
        # result would have nothing to match an institution on.
        self.assertEqual(account.bank_code, "044")
        self.assertEqual(account.account_number, "0690000032")
        self.assertEqual(account.provider, "flutterwave")

    def test_listing_banks_leaves_the_codes_alone(self) -> None:
        provider, _ = make(["banks-list"])
        banks = provider.list_banks()
        self.assertEqual(len(banks), 4)
        # Both 3-digit and 6-digit codes, untouched. This mixture is why single-code
        # normalisation was abandoned; see the bank-codes section of DESIGN.md.
        self.assertEqual([b["code"] for b in banks], ["560", "304", "044", "000019"])


class TestWallets(unittest.TestCase):
    """The capability Paystack has no answer to."""

    def test_opening_a_wallet_returns_both_identifiers(self) -> None:
        provider, _ = make(["payout-subaccount-create"])
        wallet = provider.open_wallet(account_name="Ada Example", email="ada@example.com")
        # account_reference debits the wallet; barter_id receives wallet-to-wallet money.
        # Losing either one strands the wallet.
        self.assertEqual(wallet.reference, "FLW-EXAMPLE00000000000000000000000")
        self.assertEqual(wallet.barter_id, "FLW-EXAMPLE-BARTER")
        self.assertEqual(wallet.status, "active")
        assert wallet.account is not None
        self.assertEqual(wallet.account.account_number, "8548349036")

    def test_wallet_balance_converts_the_decimal_exactly(self) -> None:
        provider, _ = make(["payout-subaccount-balance"])
        balance = provider.get_wallet_balance(reference="FLW-EXAMPLE00000000000000000000000")
        self.assertEqual(balance.available, money(120_009, "NGN"))
        self.assertEqual(balance.ledger, money(120_009, "NGN"))

    def test_non_ngn_wallet_balance_fails_locally(self) -> None:
        provider, harness = make(["payout-subaccount-balance"])
        with self.assertRaises(ValidationError) as ctx:
            provider.get_wallet_balance(reference="FLW-EXAMPLE", currency="USD")
        self.assertIn("NGN only", str(ctx.exception))
        # Failed before the network, which is the point of declaring the limit.
        self.assertEqual(len(harness.requests), 0)

    def test_wallet_payout_debits_the_wallet(self) -> None:
        provider, harness = make(["transfer-from-wallet"])
        payout = provider.transfer_from_wallet(
            wallet_reference="FLW-EXAMPLE00000000000000000000000",
            amount=naira(2500),
            reference="walletpay-01hq-example",
            account_number="0690000037",
            bank_code="044",
        )
        body = harness.body(0)
        self.assertEqual(body["debit_subaccount"], "FLW-EXAMPLE00000000000000000000000")
        self.assertEqual(body["amount"], 2500)
        self.assertEqual(payout.status, "pending")

    def test_wallet_to_wallet_uses_the_flutterwave_sentinel_bank(self) -> None:
        provider, harness = make(["transfer-from-wallet"])
        provider.transfer_from_wallet(
            wallet_reference="FLW-EXAMPLE00000000000000000000000",
            amount=naira(2500),
            reference="walletpay-01hr-example",
            to_barter_id="FLW-OTHER-BARTER",
        )
        body = harness.body(0)
        self.assertEqual(body["account_bank"], "flutterwave")
        self.assertEqual(body["account_number"], "FLW-OTHER-BARTER")

    def test_wallet_transfer_with_no_destination_fails_locally(self) -> None:
        provider, harness = make(["transfer-from-wallet"])
        with self.assertRaises(ValidationError) as ctx:
            provider.transfer_from_wallet(
                wallet_reference="FLW-EXAMPLE",
                amount=naira(2500),
                reference="walletpay-01hs-example",
            )
        self.assertIn("exactly one destination", str(ctx.exception))
        self.assertEqual(len(harness.requests), 0)

    def test_wallet_transfer_with_two_destinations_also_fails_locally(self) -> None:
        provider, _ = make(["transfer-from-wallet"])
        with self.assertRaises(ValidationError):
            provider.transfer_from_wallet(
                wallet_reference="FLW-EXAMPLE",
                amount=naira(2500),
                reference="walletpay-01ht-example",
                account_number="0690000037",
                bank_code="044",
                to_barter_id="FLW-OTHER-BARTER",
            )


class TestSplits(unittest.TestCase):
    def test_basis_points_become_flutterwaves_decimal_fraction(self) -> None:
        provider, harness = make(["subaccount-create"])
        account = provider.create_split_account(
            business_name="Example Vendor",
            account_number="0690000037",
            bank_code="044",
            business_mobile="07000000000",
            share_basis_points=900,
        )
        # 900 bps is 9%, and Flutterwave's own documentation says a 9% commission is 0.09.
        body = harness.body(0)
        self.assertEqual(body["split_type"], "percentage")
        self.assertEqual(body["split_value"], 0.09)
        # And back again, so the round trip holds.
        self.assertEqual(account.percentage_charge, 900)
        self.assertEqual(account.code, "RS_EXAMPLE4D9C66C0B1C75014EE67D4D66")

    def test_flat_default_share_sends_major_units(self) -> None:
        provider, harness = make(["subaccount-create"])
        provider.create_split_account(
            business_name="Example Vendor",
            account_number="0690000037",
            bank_code="044",
            business_mobile="07000000000",
            flat_share=naira(600),
        )
        body = harness.body(0)
        self.assertEqual(body["split_type"], "flat")
        self.assertEqual(body["split_value"], 600)

    def test_subaccount_needs_exactly_one_kind_of_default_share(self) -> None:
        provider, harness = make(["subaccount-create"])
        base = {
            "business_name": "Example Vendor",
            "account_number": "0690000037",
            "bank_code": "044",
            "business_mobile": "07000000000",
        }
        with self.assertRaises(ValidationError) as ctx:
            provider.create_split_account(**base)
        self.assertIn("exactly one of", str(ctx.exception))

        with self.assertRaises(ValidationError):
            provider.create_split_account(**base, share_basis_points=900, flat_share=naira(600))
        self.assertEqual(len(harness.requests), 0)

    def test_create_split_builds_a_declaration_and_makes_no_network_call(self) -> None:
        provider, harness = make([])
        split = provider.create_split(
            [
                {"subaccount_id": "RS_A", "commission_basis_points": 2000},
                {"subaccount_id": "RS_B", "subaccount_receives": naira(4200)},
                {"subaccount_id": "RS_C", "commission_flat": naira(100), "ratio": 2},
            ]
        )
        self.assertEqual(len(harness.requests), 0)
        self.assertEqual(
            list(split),
            [
                {"id": "RS_A", "transaction_charge_type": "percentage", "transaction_charge": 0.2},
                {
                    "id": "RS_B",
                    "transaction_charge_type": "flat_subaccount",
                    "transaction_charge": 4200,
                },
                {
                    "id": "RS_C",
                    "transaction_split_ratio": 2,
                    "transaction_charge_type": "flat",
                    "transaction_charge": 100,
                },
            ],
        )

    def test_split_party_cannot_name_two_charge_types(self) -> None:
        provider, _ = make([])
        with self.assertRaises(ValidationError) as ctx:
            provider.create_split(
                [
                    {
                        "subaccount_id": "RS_A",
                        "commission_basis_points": 2000,
                        "commission_flat": naira(100),
                    }
                ]
            )
        self.assertIn("more than one of", str(ctx.exception))

    def test_split_declaration_reaches_the_checkout_body(self) -> None:
        provider, harness = make(["payment-initialize"])
        provider.create_checkout(
            amount=naira(5000),
            email="ada@example.com",
            reference="order-01HQ-EXAMPLE",
            subaccounts=provider.create_split(
                [{"subaccount_id": "RS_A", "commission_basis_points": 2000}]
            ),
        )
        self.assertEqual(
            harness.body(0)["subaccounts"],
            [{"id": "RS_A", "transaction_charge_type": "percentage", "transaction_charge": 0.2}],
        )


class TestVirtualAccounts(unittest.TestCase):
    def test_static_account_needs_bvn_or_nin_and_says_so_locally(self) -> None:
        provider, harness = make(["virtual-account-create"])
        with self.assertRaises(KycRequiredError) as ctx:
            provider.create_static_virtual_account(
                email="ada@example.com", reference="va-01HQ-EXAMPLE"
            )
        self.assertIn("BVN or a NIN", str(ctx.exception))
        self.assertEqual(len(harness.requests), 0)

    def test_nin_accepted_in_place_of_bvn(self) -> None:
        provider, harness = make(["virtual-account-create"])
        provider.create_static_virtual_account(
            email="ada@example.com", reference="va-01HQ-EXAMPLE", nin="11111111111"
        )
        body = harness.body(0)
        self.assertEqual(body["nin"], "11111111111")
        self.assertTrue(body["is_permanent"])

    def test_acknowledged_account_is_pending_kyc_not_verified(self) -> None:
        provider, _ = make(["virtual-account-create"])
        account = provider.create_static_virtual_account(
            email="ada@example.com", reference="va-01HQ-EXAMPLE", bvn="22222222222"
        )
        # response_code "02" is "Transaction in progress": the number is usable but KYC
        # may still be running, so claiming "verified" would be a lie.
        self.assertEqual(account.kyc_status, "pending")
        self.assertEqual(account.kind, "static")
        self.assertEqual(account.accounts[0].account_number, "7824822527")

    def test_na_strings_do_not_become_amounts_or_dates(self) -> None:
        provider, _ = make(["virtual-account-create"])
        account = provider.create_static_virtual_account(
            email="ada@example.com", reference="va-01HQ-EXAMPLE", bvn="22222222222"
        )
        # The fixture has "expiry_date": "N/A" and "amount": "N/A". Parsing those gives
        # an unparseable date and a NaN amount, neither of which should ever escape.
        self.assertIsNone(account.expires_at)

    def test_dynamic_account_keeps_flutterwaves_own_expiry_default(self) -> None:
        provider, harness = make(["virtual-account-create"])
        provider.create_dynamic_virtual_account(
            email="ada@example.com", reference="va-01HR-EXAMPLE", amount=naira(5000)
        )
        body = harness.body(0)
        self.assertEqual(body["amount"], 5000)
        self.assertFalse(body["is_permanent"])
        # Not sent, so Flutterwave's own 60-second default applies. Choosing a longer one
        # here would widen the window in which a stale account still takes money.
        self.assertNotIn("expires", body)


class TestWebhooks(unittest.TestCase):
    BODY = json.dumps(
        {"event": "charge.completed", "data": {"id": 288200108, "status": "successful"}}
    ).encode("utf-8")

    def test_v4_signature_verifies_as_full_body(self) -> None:
        provider, _ = make([])
        signature = compute_signature(SCHEMES["flutterwaveV4"], self.BODY, WEBHOOK_HASH)
        result = provider.verify_webhook(
            body=self.BODY, headers={"flutterwave-signature": signature}
        )
        self.assertTrue(result["verified"])
        self.assertEqual(result["strength"], "full-body")
        self.assertEqual(result["api_version"], "v4")

    def test_v3_verif_hash_verifies_but_only_as_shared_secret(self) -> None:
        provider, _ = make([])
        result = provider.verify_webhook(body=self.BODY, headers={"verif-hash": WEBHOOK_HASH})
        # It matched, and it still proves nothing about the payload. An application that
        # requires full-body integrity can refuse this, which is why the strength is
        # reported rather than just a boolean.
        self.assertTrue(result["verified"])
        self.assertEqual(result["strength"], "shared-secret")
        self.assertEqual(result["api_version"], "v3")

    def test_v3_signature_is_identical_whatever_the_body_says(self) -> None:
        # Stated as a test because it is the security property that matters: the same
        # header authenticates any payload, so v3 has no integrity and no replay
        # protection. This is the behaviour the strength rating exists to expose.
        provider, _ = make([])
        tampered = json.dumps(
            {"event": "charge.completed", "data": {"id": 1, "status": "successful"}}
        ).encode("utf-8")

        original = provider.verify_webhook(body=self.BODY, headers={"verif-hash": WEBHOOK_HASH})
        forged = provider.verify_webhook(body=tampered, headers={"verif-hash": WEBHOOK_HASH})

        self.assertTrue(original["verified"])
        self.assertTrue(forged["verified"])
        self.assertEqual(forged["strength"], "shared-secret")

    def test_tampered_v4_body_does_not_verify(self) -> None:
        provider, _ = make([])
        signature = compute_signature(SCHEMES["flutterwaveV4"], self.BODY, WEBHOOK_HASH)
        tampered = json.dumps(
            {"event": "charge.completed", "data": {"id": 1, "status": "successful"}}
        ).encode("utf-8")

        result = provider.verify_webhook(
            body=tampered, headers={"flutterwave-signature": signature}
        )
        self.assertFalse(result["verified"])
        self.assertEqual(result["strength"], "full-body")

    def test_v4_is_preferred_when_both_headers_arrive(self) -> None:
        provider, _ = make([])
        signature = compute_signature(SCHEMES["flutterwaveV4"], self.BODY, WEBHOOK_HASH)
        result = provider.verify_webhook(
            body=self.BODY,
            headers={"flutterwave-signature": signature, "verif-hash": WEBHOOK_HASH},
        )
        # Verify the one that actually proves something.
        self.assertEqual(result["api_version"], "v4")
        self.assertEqual(result["strength"], "full-body")

    def test_no_signature_header_is_unverified(self) -> None:
        provider, _ = make([])
        result = provider.verify_webhook(body=self.BODY, headers={})
        self.assertFalse(result["verified"])
        self.assertEqual(result["strength"], "unverified")
        self.assertEqual(result["api_version"], "unknown")

    def test_headers_matched_case_insensitively(self) -> None:
        provider, _ = make([])
        result = provider.verify_webhook(body=self.BODY, headers={"Verif-Hash": WEBHOOK_HASH})
        self.assertTrue(result["verified"])

    def test_verifying_without_the_secret_hash_explains_which_secret(self) -> None:
        provider = flutterwave(secret_key=TEST_KEY, environment="test", transport=Harness([]))
        with self.assertRaises(ConfigurationError) as ctx:
            provider.verify_webhook(body=self.BODY, headers={"verif-hash": WEBHOOK_HASH})
        self.assertIn("not the API secret key", str(ctx.exception))


class TestCapabilities(unittest.TestCase):
    def test_unsupported_operation_fails_locally_with_no_network_call(self) -> None:
        from naija_pay.core.capabilities import ProviderCapabilities

        provider, harness = make(["payout-subaccount-balance"])
        # Narrow the instance's own declaration, so the real method runs on the real
        # object and the guard is what stops it.
        provider.capabilities = ProviderCapabilities(provider="flutterwave", operations={})
        with self.assertRaises(UnsupportedOperationError):
            provider.get_wallet_statement(reference="FLW-EXAMPLE")
        # The guard ran before any request was made, which is the whole point of it.
        self.assertEqual(len(harness.requests), 0)

    def test_wallets_are_declared_unlike_paystack(self) -> None:
        provider, _ = make([])
        self.assertTrue(supports(provider.capabilities, "wallets.open"))
        self.assertTrue(supports(provider.capabilities, "wallets.balance"))
        self.assertTrue(supports(provider.capabilities, "wallets.transfer"))

    def test_dynamic_virtual_accounts_are_declared_unlike_paystack(self) -> None:
        provider, _ = make([])
        self.assertTrue(supports(provider.capabilities, "virtualAccounts.createDynamic"))

    def test_doc_only_operations_are_flagged_not_sandbox_verified(self) -> None:
        provider, _ = make([])
        unverified = operations_not_sandbox_verified(provider.capabilities)
        # Nothing has been run against Flutterwave's sandbox yet, so the wallet and
        # virtual-account operations must say so rather than looking proven.
        self.assertIn("wallets.open", unverified)
        self.assertIn("virtualAccounts.createStatic", unverified)

    def test_webhook_declaration_is_honest_about_v3(self) -> None:
        provider, _ = make([])
        signature = provider.capabilities.webhook_signature
        assert signature is not None
        self.assertEqual(signature.strength, "shared-secret")
        self.assertIn("no signature at all", signature.algorithm or "")

    def test_404_is_typed_not_found(self) -> None:
        provider, _ = make([(404, {"status": "error", "message": "No transaction was found"})])
        with self.assertRaises(NotFoundError):
            provider.verify_transaction(1)


if __name__ == "__main__":
    unittest.main()
