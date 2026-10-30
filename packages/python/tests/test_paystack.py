"""Paystack adapter tests, mirroring packages/ts/test/paystack.test.ts.

Everything runs against the recorded fixtures in fixtures/providers/paystack/ through a
fake transport, so there is no network and no keys.
"""

import json
import pathlib
import sys
import unittest
from typing import Any

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "src"))

from naija_pay.core.capabilities import assert_supported, supports  # noqa: E402
from naija_pay.core.errors import (  # noqa: E402
    ConfigurationError,
    DuplicateReferenceError,
    KycRequiredError,
    PayoutStatusUnknownError,
    UnsupportedOperationError,
    ValidationError,
)
from naija_pay.core.http import TransportRequest, TransportResponse  # noqa: E402
from naija_pay.core.money import money, naira  # noqa: E402
from naija_pay.core.signatures import SCHEMES, compute_signature  # noqa: E402
from naija_pay.providers.paystack import paystack  # noqa: E402

FIXTURES = pathlib.Path(__file__).resolve().parents[3] / "fixtures" / "providers" / "paystack"
TEST_KEY = "sk_test_EXAMPLEpaystack"


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
    provider = paystack(
        secret_key=TEST_KEY,
        environment="test",
        transport=harness,
        sleep=lambda _seconds: None,
        **extra,
    )
    return provider, harness


class TestConstructionAndKeySafety(unittest.TestCase):
    def test_accepts_test_key(self) -> None:
        provider, _ = make(["transaction-verify-success"])
        self.assertEqual(provider.name, "paystack")

    def test_refuses_live_key_in_test_environment(self) -> None:
        # The check that matters most: Paystack serves test and live from one host, so
        # nothing else would catch this before real money moved.
        with self.assertRaises(ConfigurationError) as ctx:
            paystack(
                secret_key="sk_live_EXAMPLEreal",
                environment="test",
                transport=Harness([]),
            )
        self.assertIn("LIVE secret key", str(ctx.exception))
        self.assertIn("same host", str(ctx.exception))

    def test_refuses_test_key_in_live_environment(self) -> None:
        with self.assertRaises(ConfigurationError) as ctx:
            paystack(secret_key=TEST_KEY, environment="live", transport=Harness([]))
        self.assertIn("TEST secret key", str(ctx.exception))

    def test_refuses_public_key(self) -> None:
        with self.assertRaises(ConfigurationError) as ctx:
            paystack(secret_key="pk_test_EXAMPLEpublic", transport=Harness([]))
        self.assertIn("must be a secret key", str(ctx.exception))

    def test_refuses_missing_key(self) -> None:
        with self.assertRaises(ConfigurationError):
            paystack(secret_key="", transport=Harness([]))

    def test_warns_on_live_key_outside_production(self) -> None:
        warnings: list[str] = []
        paystack(
            secret_key="sk_live_EXAMPLEreal",
            environment="live",
            transport=Harness([]),
            on_live_key_warning=warnings.append,
        )
        self.assertEqual(len(warnings), 1)
        self.assertIn("Real money will move", warnings[0])

    def test_key_never_reaches_a_log_event(self) -> None:
        events: list[dict] = []
        provider, _ = make(["transaction-verify-success"], on_log=events.append)
        provider.verify_transaction("order_01HQ")
        self.assertNotIn(TEST_KEY, json.dumps(events))


class TestCollections(unittest.TestCase):
    def test_initializes_checkout_with_string_amount(self) -> None:
        provider, harness = make(["transaction-initialize"])
        checkout = provider.create_checkout(
            amount=naira(5_000),
            email="ada@example.com",
            reference="order_01HQ",
            channels=["card", "bank_transfer"],
        )

        self.assertEqual(checkout["checkout_url"], "https://checkout.paystack.com/3ni8kdavz62431k")
        self.assertEqual(checkout["reference"], "order_01HQ")

        body = harness.body(0)
        self.assertEqual(body["amount"], "500000")
        self.assertEqual(body["currency"], "NGN")
        self.assertEqual(body["channels"], ["card", "bank_transfer"])
        self.assertEqual(harness.requests[0].headers["authorization"], f"Bearer {TEST_KEY}")

    def test_maps_channel_names(self) -> None:
        provider, harness = make(["transaction-initialize"])
        provider.create_checkout(
            amount=naira(5_000), email="ada@example.com", channels=["bank_account", "ussd"]
        )
        # Ours is `bank_account`; Paystack calls the same thing `bank`.
        self.assertEqual(harness.body(0)["channels"], ["bank", "ussd"])

    def test_refuses_unsupported_channel_locally(self) -> None:
        provider, harness = make(["transaction-initialize"])
        with self.assertRaises(ValidationError) as ctx:
            provider.create_checkout(
                amount=naira(5_000), email="ada@example.com", channels=["google_pay"]
            )
        self.assertIn("google_pay", str(ctx.exception))
        self.assertEqual(len(harness.requests), 0, "must fail locally, not at the provider")

    def test_normalises_successful_verification(self) -> None:
        provider, _ = make(["transaction-verify-success"])
        txn = provider.verify_transaction("order_01HQ")

        self.assertEqual(txn.status, "successful")
        self.assertEqual(txn.reference, "order_01HQ")
        self.assertEqual(txn.provider_reference, "4099260516")
        # Paystack returns both; conflating them would hide partial and over payments.
        assert txn.amount is not None and txn.amount_paid is not None
        self.assertEqual(txn.amount.amount, 30_050)
        self.assertEqual(txn.amount_paid.amount, 40_333)
        assert txn.fees is not None
        self.assertEqual(txn.fees.amount, 10_283)
        self.assertEqual(txn.channel, "card")
        assert txn.customer is not None
        self.assertEqual(txn.customer.email, "ada@example.com")
        self.assertEqual(txn.customer.name, "Ada Obi")
        assert txn.authorization is not None
        self.assertEqual(txn.authorization.code, "AUTH_uh8bcl3zbn")
        self.assertTrue(txn.authorization.reusable)
        self.assertIsNotNone(txn.paid_at)
        self.assertIsNotNone(txn.raw)

    def test_collapses_in_flight_status_to_pending(self) -> None:
        provider, _ = make(["transaction-verify-pending"])
        # "ongoing" means not finished. Mapping it to anything but pending could cause
        # an application to give value early.
        self.assertEqual(provider.verify_transaction("order_pending").status, "pending")

    def test_creates_refund(self) -> None:
        provider, harness = make(["refund-create"])
        refund = provider.create_refund(transaction="order_01HQ")
        self.assertEqual(refund.status, "pending")
        self.assertEqual(refund.transaction_reference, "order_01HQ")
        assert refund.amount is not None
        self.assertEqual(refund.amount.amount, 500_000)
        self.assertEqual(len(harness.requests), 1)

    def test_refund_never_retried(self) -> None:
        provider, harness = make([(503, {})])
        with self.assertRaises(PayoutStatusUnknownError):
            provider.create_refund(transaction="order_01HQ")
        self.assertEqual(len(harness.requests), 1, "refunding twice is worse than failing")


class TestVirtualAccounts(unittest.TestCase):
    def test_requires_bvn_locally(self) -> None:
        provider, harness = make(["dedicated-account-assign"])
        with self.assertRaises(KycRequiredError) as ctx:
            provider.create_static_virtual_account(
                email="ada@example.com",
                first_name="Ada",
                last_name="Obi",
                phone="+2348100000000",
                preferred_bank="wema-bank",
            )
        self.assertEqual(ctx.exception.required, ("bvn",))
        self.assertIn("CBN rules", str(ctx.exception))
        self.assertEqual(len(harness.requests), 0)

    def test_assign_reports_pending_not_an_account_number(self) -> None:
        provider, harness = make(["dedicated-account-assign"])
        result = provider.create_static_virtual_account(
            email="ada@example.com",
            first_name="Ada",
            last_name="Obi",
            phone="+2348100000000",
            preferred_bank="wema-bank",
            bvn="22222222222",
        )
        # Paystack only acknowledges; the account arrives by webhook. Inventing an
        # account number here would be a lie the caller could act on.
        self.assertEqual(result["status"], "pending")
        self.assertIn("in progress", result["message"])
        self.assertEqual(harness.body(0)["bvn"], "22222222222")

    def test_normalises_fetched_account_with_enrichment(self) -> None:
        provider, _ = make(["dedicated-account-get"])
        account = provider.get_virtual_account("253")

        self.assertEqual(account.accounts[0].account_number, "9930000737")
        self.assertEqual(account.accounts[0].bank_slug, "wema-bank")
        assert account.accounts[0].institution is not None
        self.assertEqual(account.accounts[0].institution.id, "wema-bank")
        self.assertEqual(account.status, "active")
        # Identification is asynchronous on Paystack, so a fresh account is pending.
        self.assertEqual(account.kyc_status, "pending")


class TestSplitsAndSubaccounts(unittest.TestCase):
    def test_creates_subaccount_sending_both_field_names(self) -> None:
        provider, harness = make(["subaccount-create"])
        account = provider.create_split_account(
            business_name="Ada Fabrics",
            bank_code="044",
            account_number="0123456789",
            percentage_charge=2.5,
        )
        self.assertEqual(account.code, "ACCT_6uujpqtzmnufzkw")
        self.assertFalse(account.verified)
        assert account.settlement_account is not None
        assert account.settlement_account.institution is not None
        self.assertEqual(account.settlement_account.institution.id, "access-bank")

        body = harness.body(0)
        # The reference says bank_code, the cURL sample sends settlement_bank. Sending
        # both costs nothing and tolerates either.
        self.assertEqual(body["bank_code"], "044")
        self.assertEqual(body["settlement_bank"], "044")

    def test_converts_basis_points_to_percentage(self) -> None:
        provider, harness = make(["split-create"])
        split = provider.create_split(
            name="marketplace",
            split_type="percentage",
            currency="NGN",
            parties=[{"account": "ACCT_6uujpqtzmnufzkw", "share": 9_000}],
        )
        self.assertEqual(split.code, "SPL_RcScyW5jp2")
        self.assertEqual(harness.body(0)["subaccounts"][0]["share"], 90)

    def test_refuses_fractional_and_over_100_percent(self) -> None:
        provider, _ = make(["split-create"])
        with self.assertRaises(ValidationError):
            provider.create_split(
                name="x",
                split_type="percentage",
                currency="NGN",
                parties=[{"account": "ACCT_1", "share": 12.5}],
            )
        with self.assertRaises(ValidationError) as ctx:
            provider.create_split(
                name="x",
                split_type="percentage",
                currency="NGN",
                parties=[
                    {"account": "ACCT_1", "share": 6_000},
                    {"account": "ACCT_2", "share": 5_000},
                ],
            )
        self.assertIn("more than 100%", str(ctx.exception))


class TestPayouts(unittest.TestCase):
    def test_validates_reference_format_locally(self) -> None:
        provider, harness = make(["transferrecipient-create", "transfer-create"])
        for reference in ("short", "Payout_With_Capitals_01", "has spaces in it ok"):
            with self.assertRaises(ValidationError) as ctx:
                provider.create_payout(
                    amount=naira(25_000),
                    account_number="0123456789",
                    bank_code="044",
                    account_name="ADA OBI",
                    reference=reference,
                )
            self.assertIn("16 to 50 characters", str(ctx.exception))
        self.assertEqual(
            len(harness.requests), 0, "a malformed reference must never reach the provider"
        )

    def test_creates_recipient_then_transfer(self) -> None:
        provider, harness = make(["transferrecipient-create", "transfer-create"])
        payout = provider.create_payout(
            amount=naira(25_000),
            account_number="0123456789",
            bank_code="044",
            account_name="ADA OBI",
            reference="payout-01hq-abcdefgh",
            reason="Vendor settlement",
        )

        self.assertEqual(len(harness.requests), 2)
        self.assertTrue(harness.requests[0].url.endswith("/transferrecipient"))
        self.assertTrue(harness.requests[1].url.endswith("/transfer"))

        transfer_body = harness.body(1)
        self.assertEqual(transfer_body["recipient"], "RCP_m7ljkv8leesep7p")
        self.assertEqual(transfer_body["amount"], 2_500_000)
        self.assertEqual(transfer_body["source"], "balance")

        self.assertEqual(payout.status, "successful")
        self.assertEqual(payout.provider_reference, "TRF_v5tip3zx8nna9o78")
        self.assertFalse(payout.awaiting_otp)

    def test_otp_transfer_is_pending_not_successful(self) -> None:
        # The trap: Paystack returns HTTP 200 with status "otp" when OTP is enabled, and
        # the transfer has NOT happened until a human enters the code.
        provider, _ = make(["transferrecipient-create", "transfer-create-otp"])
        payout = provider.create_payout(
            amount=naira(25_000),
            account_number="0123456789",
            bank_code="044",
            account_name="ADA OBI",
            reference="payout-01hq-otpcase1",
        )
        self.assertEqual(payout.status, "pending")
        self.assertTrue(payout.awaiting_otp, "the caller must be told a human is needed")

    def test_transfer_never_retried(self) -> None:
        provider, harness = make(
            ["transferrecipient-create", (503, {}), (200, fixture("transfer-create"))]
        )
        with self.assertRaises(PayoutStatusUnknownError) as ctx:
            provider.create_payout(
                amount=naira(25_000),
                account_number="0123456789",
                bank_code="044",
                account_name="ADA OBI",
                reference="payout-01hq-abcdefgh",
            )
        self.assertEqual(ctx.exception.reference, "payout-01hq-abcdefgh")
        self.assertFalse(ctx.exception.retryable)
        self.assertEqual(len(harness.requests), 2, "recipient once, transfer once")

    def test_resolves_account_without_substituting_the_code(self) -> None:
        provider, _ = make(["bank-resolve"])
        account = provider.resolve_account(account_number="0123456789", bank_code="044")

        self.assertEqual(account.account_name, "ADA OBI")
        # Paystack's own code is preserved verbatim; naija-data only enriches.
        self.assertEqual(account.bank_code, "044")
        assert account.institution is not None
        self.assertEqual(account.institution.id, "access-bank")
        self.assertEqual(account.institution.matched_by, "cbn_code")
        self.assertIsNone(account.merger_warning)


class TestErrors(unittest.TestCase):
    def test_status_false_on_200_is_a_failure(self) -> None:
        # Paystack normally uses correct HTTP statuses, but this envelope is possible
        # and reading it as success would be the worst kind of bug.
        provider, _ = make([(200, fixture("error-duplicate-reference"))])
        with self.assertRaises(Exception) as ctx:
            provider.create_checkout(amount=naira(5_000), email="ada@example.com")
        self.assertIn("Duplicate Transaction Reference", str(ctx.exception))

    def test_classifies_duplicate_reference(self) -> None:
        provider, _ = make(
            [(400, {"status": False, "message": "Duplicate Transaction Reference"})]
        )
        with self.assertRaises(DuplicateReferenceError):
            provider.verify_transaction("order_01HQ")

    def test_classifies_bvn_failure_as_kyc_required(self) -> None:
        provider, _ = make([(400, {"status": False, "message": "Customer BVN is invalid"})])
        with self.assertRaises(KycRequiredError):
            provider.verify_transaction("order_01HQ")


class TestCapabilities(unittest.TestCase):
    def test_declares_what_it_implements(self) -> None:
        provider, _ = make([])
        for operation in (
            "checkout.create",
            "virtualAccounts.createStatic",
            "splits.create",
            "payouts.create",
        ):
            self.assertTrue(supports(provider.capabilities, operation), operation)

    def test_refuses_wallets_outright(self) -> None:
        # Pretending otherwise would be the worst thing this SDK could do.
        provider, _ = make([])
        self.assertFalse(supports(provider.capabilities, "wallets.open"))
        with self.assertRaises(UnsupportedOperationError) as ctx:
            assert_supported(provider.capabilities, "wallets.open")
        self.assertIn("paystack does not support wallets.open", str(ctx.exception))

    def test_declares_full_body_signature(self) -> None:
        provider, _ = make([])
        assert provider.capabilities.webhook_signature is not None
        self.assertEqual(provider.capabilities.webhook_signature.strength, "full-body")
        self.assertEqual(
            provider.capabilities.webhook_signature.header, "x-paystack-signature"
        )

    def test_records_what_is_not_yet_implemented(self) -> None:
        provider, _ = make([])
        self.assertIn("mandates.create", provider.not_yet_implemented)
        self.assertIn("milestone 7", provider.not_yet_implemented["mandates.create"])


class TestWebhooks(unittest.TestCase):
    def test_verifies_a_signed_webhook(self) -> None:
        provider, _ = make([])
        body = b'{"event":"charge.success","data":{"reference":"order_01HQ"}}'
        signature = compute_signature(SCHEMES["paystack"], body, TEST_KEY)

        result = provider.verify_webhook(
            body=body, headers={"x-paystack-signature": signature}
        )
        self.assertTrue(result.verified)
        self.assertEqual(result.strength, "full-body")

    def test_rejects_tampered_body(self) -> None:
        provider, _ = make([])
        body = b'{"event":"charge.success","data":{"amount":100}}'
        signature = compute_signature(SCHEMES["paystack"], body, TEST_KEY)

        result = provider.verify_webhook(
            body=b'{"event":"charge.success","data":{"amount":9999999}}',
            headers={"x-paystack-signature": signature},
        )
        self.assertFalse(result.verified)

    def test_knows_documented_webhook_ips(self) -> None:
        provider, _ = make([])
        self.assertTrue(provider.is_known_webhook_ip("52.31.139.75"))
        self.assertTrue(provider.is_known_webhook_ip("52.214.14.220"))
        self.assertFalse(provider.is_known_webhook_ip("1.2.3.4"))


class TestMoneyHandling(unittest.TestCase):
    def test_sends_integer_minor_units_on_transfer(self) -> None:
        provider, harness = make(["transferrecipient-create", "transfer-create"])
        provider.create_payout(
            amount=money(123_456, "NGN"),
            account_number="0123456789",
            bank_code="044",
            account_name="ADA OBI",
            reference="payout-01hq-abcdefgh",
        )
        amount = harness.body(1)["amount"]
        self.assertEqual(amount, 123_456)
        self.assertIsInstance(amount, int)


if __name__ == "__main__":
    unittest.main()
