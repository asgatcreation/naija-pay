"""Mock provider and inflow-rule tests, mirroring packages/ts/test/mock-provider.test.ts."""

import pathlib
import sys
import unittest
from datetime import datetime, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "src"))

from naija_pay.core.capabilities import (  # noqa: E402
    assert_supported,
    required_kyc_for,
    supports,
)
from naija_pay.core.errors import UnsupportedOperationError  # noqa: E402
from naija_pay.core.events import (  # noqa: E402
    DEFAULT_INFLOW_RULES,
    InflowRules,
    MemoryStore,
    classify_inflow,
    decide_inflow,
)
from naija_pay.core.money import naira  # noqa: E402
from naija_pay.core.signatures import verify_signature  # noqa: E402
from naija_pay.providers.mock import (  # noqa: E402
    INFLOW_SCENARIOS,
    MOCK_SCHEME,
    mock,
)


def fixed_now() -> datetime:
    return datetime(2026, 10, 30, 12, 0, 0, tzinfo=timezone.utc)


class TestClassifyingInflow(unittest.TestCase):
    def test_exact(self) -> None:
        result = classify_inflow(expected_amount=naira(5_000), amount_paid=naira(5_000))
        self.assertEqual(result.variance, "exact")
        assert result.variance_amount is not None
        self.assertEqual(result.variance_amount.amount, 0)
        self.assertFalse(result.is_late)

    def test_overpayment(self) -> None:
        result = classify_inflow(expected_amount=naira(5_000), amount_paid=naira(5_500))
        self.assertEqual(result.variance, "overpayment")
        assert result.variance_amount is not None
        self.assertEqual(result.variance_amount.amount, 50_000)

    def test_underpayment_is_positive(self) -> None:
        result = classify_inflow(expected_amount=naira(5_000), amount_paid=naira(4_900))
        self.assertEqual(result.variance, "underpayment")
        assert result.variance_amount is not None
        self.assertEqual(result.variance_amount.amount, 10_000)

    def test_static_account_has_no_expected_amount(self) -> None:
        result = classify_inflow(expected_amount=None, amount_paid=naira(12_000))
        self.assertEqual(result.variance, "unexpected")
        self.assertIsNone(result.variance_amount)

    def test_detects_late_payment(self) -> None:
        result = classify_inflow(
            expected_amount=naira(5_000),
            amount_paid=naira(5_000),
            expires_at=datetime(2026, 10, 30, 10, 0, tzinfo=timezone.utc),
            paid_at=datetime(2026, 10, 30, 10, 20, tzinfo=timezone.utc),
        )
        self.assertTrue(result.is_late)
        self.assertEqual(result.variance, "exact")

    def test_not_late_when_in_time(self) -> None:
        result = classify_inflow(
            expected_amount=naira(5_000),
            amount_paid=naira(5_000),
            expires_at=datetime(2026, 10, 30, 10, 0, tzinfo=timezone.utc),
            paid_at=datetime(2026, 10, 30, 9, 59, tzinfo=timezone.utc),
        )
        self.assertFalse(result.is_late)


class TestDecidingInflow(unittest.TestCase):
    def test_credits_exact(self) -> None:
        decision = decide_inflow(
            variance="exact", amount_paid=naira(5_000), expected_amount=naira(5_000)
        )
        self.assertEqual(decision.action, "credit")
        assert decision.amount is not None
        self.assertEqual(decision.amount.amount, 500_000)

    def test_duplicate_always_ignored(self) -> None:
        # Not configurable on purpose: every Tier 1 provider retries webhooks --
        # Paystack for 72 hours -- so duplicates are certain, and "give value twice"
        # must never be reachable through configuration.
        for rules in (
            DEFAULT_INFLOW_RULES,
            InflowRules(
                overpayment="credit_full", underpayment="credit_partial", late_payment="accept"
            ),
        ):
            decision = decide_inflow(
                variance="exact",
                amount_paid=naira(5_000),
                expected_amount=naira(5_000),
                rules=rules,
                already_processed=True,
            )
            self.assertEqual(decision.action, "ignore")
            self.assertIn("already been processed", decision.reason)

    def test_overpayment_rules(self) -> None:
        common = {
            "variance": "overpayment",
            "amount_paid": naira(5_500),
            "expected_amount": naira(5_000),
        }

        full = decide_inflow(**common, rules=InflowRules(overpayment="credit_full"))
        self.assertEqual(full.action, "credit")
        assert full.amount is not None
        self.assertEqual(full.amount.amount, 550_000)

        expected = decide_inflow(**common, rules=InflowRules(overpayment="credit_expected"))
        self.assertEqual(expected.action, "credit")
        assert expected.amount is not None
        self.assertEqual(expected.amount.amount, 500_000)
        self.assertIn("excess needs refunding", expected.reason)

        self.assertEqual(
            decide_inflow(**common, rules=InflowRules(overpayment="reject")).action, "reject"
        )
        self.assertEqual(
            decide_inflow(**common, rules=InflowRules(overpayment="manual_review")).action,
            "manual_review",
        )

    def test_underpayment_rules_default_to_review(self) -> None:
        common = {
            "variance": "underpayment",
            "amount_paid": naira(4_900),
            "expected_amount": naira(5_000),
        }

        # The conservative default: partial credit silently changes what the customer
        # bought, so it must be opted into.
        self.assertEqual(decide_inflow(**common).action, "manual_review")

        partial = decide_inflow(**common, rules=InflowRules(underpayment="credit_partial"))
        self.assertEqual(partial.action, "credit")
        assert partial.amount is not None
        self.assertEqual(partial.amount.amount, 490_000)

        self.assertEqual(
            decide_inflow(**common, rules=InflowRules(underpayment="reject")).action, "reject"
        )

    def test_lateness_decided_first_and_accept_falls_through(self) -> None:
        common = {
            "variance": "exact",
            "amount_paid": naira(5_000),
            "expected_amount": naira(5_000),
            "is_late": True,
        }
        self.assertEqual(decide_inflow(**common).action, "credit")
        self.assertEqual(
            decide_inflow(**common, rules=InflowRules(late_payment="reject")).action, "reject"
        )
        self.assertEqual(
            decide_inflow(**common, rules=InflowRules(late_payment="manual_review")).action,
            "manual_review",
        )

    def test_late_and_underpaid(self) -> None:
        decision = decide_inflow(
            variance="underpayment",
            amount_paid=naira(4_000),
            expected_amount=naira(5_000),
            is_late=True,
        )
        # Late is accepted by default, so the underpayment rule decides.
        self.assertEqual(decision.action, "manual_review")

    def test_credits_static_account(self) -> None:
        decision = decide_inflow(variance="unexpected", amount_paid=naira(12_000))
        self.assertEqual(decision.action, "credit")
        assert decision.amount is not None
        self.assertEqual(decision.amount.amount, 1_200_000)


class TestIdempotencyStore(unittest.TestCase):
    def test_remembers_what_it_has_seen(self) -> None:
        store = MemoryStore()
        self.assertFalse(store.has("evt_1"))
        store.mark("evt_1")
        self.assertTrue(store.has("evt_1"))
        self.assertFalse(store.has("evt_2"))
        self.assertEqual(store.size(), 1)


class TestMockProvider(unittest.TestCase):
    def test_webhooks_pass_real_signature_verification(self) -> None:
        # The whole point: the security path is not stubbed. The same verifier that runs
        # against Paystack runs against the mock.
        provider = mock(now=fixed_now)
        webhook = provider.simulate_inflow(
            expected_amount=naira(5_000), amount_paid=naira(5_000)
        )
        result = verify_signature(
            scheme=MOCK_SCHEME,
            body=webhook.body,
            headers=webhook.headers,
            secret=provider.secret,
        )
        self.assertTrue(result.verified, result.reason)
        self.assertEqual(result.strength, "full-body")

    def test_can_emit_invalid_signature(self) -> None:
        provider = mock(now=fixed_now)
        webhook = provider.simulate_inflow(amount_paid=naira(5_000), invalid_signature=True)
        result = verify_signature(
            scheme=MOCK_SCHEME,
            body=webhook.body,
            headers=webhook.headers,
            secret=provider.secret,
        )
        self.assertFalse(result.verified)
        self.assertEqual(webhook.event.signature_strength, "unverified")

    def test_tampering_is_detected(self) -> None:
        provider = mock(now=fixed_now)
        webhook = provider.simulate_inflow(
            expected_amount=naira(5_000), amount_paid=naira(5_000)
        )
        tampered = webhook.text.replace("500000", "99999999").encode("utf-8")
        result = verify_signature(
            scheme=MOCK_SCHEME,
            body=tampered,
            headers=webhook.headers,
            secret=provider.secret,
        )
        self.assertFalse(result.verified)

    def test_covers_every_inflow_edge_case(self) -> None:
        provider = mock(now=fixed_now)
        for scenario in INFLOW_SCENARIOS:
            webhook = provider.simulate_inflow(**scenario["options"])
            self.assertEqual(
                webhook.event.data["variance"],
                scenario["expected_variance"],
                f"{scenario['name']}: got {webhook.event.data['variance']}",
            )
            self.assertEqual(webhook.event.type, "virtual_account.credited")
            verified = verify_signature(
                scheme=MOCK_SCHEME,
                body=webhook.body,
                headers=webhook.headers,
                secret=provider.secret,
            )
            self.assertTrue(verified.verified, f"{scenario['name']}: signature did not verify")

    def test_late_scenarios_marked_late(self) -> None:
        provider = mock(now=fixed_now)
        for scenario in INFLOW_SCENARIOS:
            if "late" not in scenario["name"]:
                continue
            webhook = provider.simulate_inflow(**scenario["options"])
            self.assertTrue(webhook.event.data["is_late"], scenario["name"])

    def test_deterministic_sequential_event_ids(self) -> None:
        provider = mock(now=fixed_now)
        first = provider.simulate_payment(status="successful")
        second = provider.simulate_payment(status="failed")
        self.assertEqual(first.event.id, "evt_mock_0001")
        self.assertEqual(second.event.id, "evt_mock_0002")

    def test_can_replay_the_same_event(self) -> None:
        provider = mock(now=fixed_now)
        original = provider.simulate_payment(status="successful")
        replay = provider.build_webhook(
            event_type=original.event.type,
            data=original.event.data,
            event_id=original.event.id,
            occurred_at=original.event.occurred_at,
        )

        # A genuine redelivery: identical bytes and identical signature.
        self.assertEqual(replay.text, original.text)
        self.assertEqual(dict(replay.headers), dict(original.headers))

        store = MemoryStore()
        store.mark(original.event.id)
        decision = decide_inflow(
            variance="exact",
            amount_paid=naira(5_000),
            expected_amount=naira(5_000),
            already_processed=store.has(replay.event.id),
        )
        self.assertEqual(decision.action, "ignore")

    def test_simulates_every_terminal_state(self) -> None:
        provider = mock(now=fixed_now)
        for status in ("successful", "failed", "pending", "reversed"):
            self.assertEqual(
                provider.simulate_payment(status=status).event.type, f"payment.{status}"
            )
        for status in ("successful", "failed", "reversed"):
            self.assertEqual(
                provider.simulate_transfer(status=status).event.type, f"transfer.{status}"
            )


class TestMockCapabilities(unittest.TestCase):
    def test_supports_the_whole_api(self) -> None:
        provider = mock()
        self.assertTrue(supports(provider.capabilities, "wallets.open"))
        self.assertTrue(supports(provider.capabilities, "splits.create"))
        self.assertTrue(supports(provider.capabilities, "mandates.debit"))
        assert_supported(provider.capabilities, "payouts.create")

    def test_still_refuses_an_unknown_operation(self) -> None:
        provider = mock()
        with self.assertRaises(UnsupportedOperationError):
            assert_supported(provider.capabilities, "not.a.real.operation")

    def test_requires_bvn_for_static_virtual_account(self) -> None:
        provider = mock()
        self.assertEqual(
            required_kyc_for(provider.capabilities, "virtualAccounts.createStatic"), ("bvn",)
        )

    def test_declares_full_body_signature(self) -> None:
        provider = mock()
        assert provider.capabilities.webhook_signature is not None
        self.assertEqual(provider.capabilities.webhook_signature.strength, "full-body")
        self.assertEqual(provider.capabilities.webhook_signature.header, MOCK_SCHEME.header)


if __name__ == "__main__":
    unittest.main()
