"""Core tests, mirroring packages/ts/test/money.test.ts and redact.test.ts.

Standard library only, so these run with no installs.
"""

import json
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "src"))

from naija_pay.core import (  # noqa: E402
    BASIS_POINTS_TOTAL,
    AuthenticationError,
    DuplicateReferenceError,
    KycRequiredError,
    MoneyError,
    NaijaPayError,
    NetworkError,
    PayoutStatusUnknownError,
    ProviderDownError,
    RateLimitedError,
    Share,
    UnsupportedOperationError,
    ValidationError,
    add,
    compare,
    error_class_for_status,
    format_money,
    from_major,
    looks_like_live_key,
    looks_like_test_key,
    mask_account_number,
    mask_identity_number,
    money,
    naira,
    redact,
    redact_object,
    split_by_basis_points,
    split_by_flat_amounts,
    subtract,
)

# Obviously fake values, matching the ones the fixtures use.
BVN = "22222222222"
NIN = "12345678901"
ACCOUNT = "0123456789"


class TestMoneyConstruction(unittest.TestCase):
    def test_takes_integer_minor_units(self) -> None:
        m = money(15_000, "NGN")
        self.assertEqual((m.amount, m.currency), (15_000, "NGN"))

    def test_naira_converts_to_kobo(self) -> None:
        self.assertEqual(naira(150).amount, 15_000)
        self.assertEqual(naira(0).amount, 0)

    def test_rejects_float_with_explanatory_message(self) -> None:
        with self.assertRaises(MoneyError) as ctx:
            money(1.5, "NGN")  # type: ignore[arg-type]
        self.assertIn("must be an integer", str(ctx.exception))
        self.assertIn("1.50 is 150", str(ctx.exception))

    def test_rejects_negative_and_unsafe(self) -> None:
        for bad in (-1, 9_007_199_254_740_993):
            with self.assertRaises(MoneyError):
                money(bad, "NGN")

    def test_rejects_bool_which_is_an_int_subclass(self) -> None:
        with self.assertRaises(MoneyError):
            money(True, "NGN")  # type: ignore[arg-type]

    def test_rejects_unknown_currency(self) -> None:
        with self.assertRaises(MoneyError) as ctx:
            money(100, "GBP")
        self.assertIn("unknown currency", str(ctx.exception))

    def test_is_frozen(self) -> None:
        m = naira(100)
        with self.assertRaises(Exception):
            m.amount = 999  # type: ignore[misc]


class TestFromMajor(unittest.TestCase):
    def test_handles_float_multiplication_trap(self) -> None:
        self.assertEqual(from_major(1.15, "NGN").amount, 115)
        self.assertEqual(from_major(0.07, "NGN").amount, 7)
        self.assertEqual(from_major(150.75, "NGN").amount, 15_075)

    def test_refuses_excess_precision(self) -> None:
        with self.assertRaises(MoneyError) as ctx:
            from_major(1.005, "NGN")
        self.assertIn("more precision", str(ctx.exception))

    def test_refuses_fractional_xof(self) -> None:
        self.assertEqual(from_major(100, "XOF").amount, 10_000)
        with self.assertRaises(MoneyError) as ctx:
            from_major(100.5, "XOF")
        self.assertIn("no subunit", str(ctx.exception))


class TestArithmetic(unittest.TestCase):
    def test_add_and_subtract(self) -> None:
        self.assertEqual(add(naira(10), naira(5)).amount, 1_500)
        self.assertEqual(subtract(naira(10), naira(5)).amount, 500)

    def test_refuses_mixed_currencies(self) -> None:
        with self.assertRaises(MoneyError) as ctx:
            add(naira(10), money(500, "USD"))
        self.assertIn("cannot combine NGN and USD", str(ctx.exception))

    def test_refuses_negative_result(self) -> None:
        with self.assertRaises(MoneyError):
            subtract(naira(5), naira(10))

    def test_compare(self) -> None:
        self.assertEqual(compare(naira(5), naira(10)), -1)
        self.assertEqual(compare(naira(10), naira(10)), 0)
        self.assertEqual(compare(naira(15), naira(10)), 1)

    def test_format(self) -> None:
        self.assertEqual(format_money(money(15_075, "NGN")), "NGN 150.75")
        self.assertEqual(format_money(money(5, "NGN")), "NGN 0.05")
        self.assertEqual(format_money(money(0, "NGN")), "NGN 0.00")


class TestSplits(unittest.TestCase):
    def test_basis_point_split_with_remainder(self) -> None:
        result = split_by_basis_points(naira(100), [Share("vendor", 9_000)])
        self.assertEqual(len(result.parts), 1)
        self.assertEqual(result.parts[0].amount.amount, 9_000)
        self.assertEqual(result.remainder.amount, 1_000)

    def test_uneven_split_loses_nothing(self) -> None:
        total = money(10_001, "NGN")
        result = split_by_basis_points(
            total, [Share("a", 3_333), Share("b", 3_333), Share("c", 3_333)]
        )
        paid = sum(p.amount.amount for p in result.parts)
        self.assertEqual(paid + result.remainder.amount, 10_001)
        for p in result.parts:
            self.assertEqual(p.amount.amount, 3_333)

    def test_refuses_over_100_percent(self) -> None:
        with self.assertRaises(MoneyError) as ctx:
            split_by_basis_points(naira(100), [Share("a", 6_000), Share("b", 5_000)])
        self.assertIn("more than 100%", str(ctx.exception))

    def test_refuses_fractional_share(self) -> None:
        with self.assertRaises(MoneyError) as ctx:
            split_by_basis_points(naira(100), [Share("a", 12.5)])  # type: ignore[arg-type]
        self.assertIn("non-negative integer", str(ctx.exception))

    def test_flat_split(self) -> None:
        result = split_by_flat_amounts(naira(100), [Share("a", 2_500)])
        self.assertEqual(result.parts[0].amount.amount, 2_500)
        self.assertEqual(result.remainder.amount, 7_500)

    def test_refuses_flat_shares_over_total(self) -> None:
        with self.assertRaises(MoneyError) as ctx:
            split_by_flat_amounts(naira(10), [Share("a", 2_000)])
        self.assertIn("more than the 1000 being split", str(ctx.exception))

    def test_property_parts_plus_remainder_equal_total(self) -> None:
        # Same deterministic generator as the TypeScript test, same seed, so both
        # languages exercise identical cases.
        seed = 42

        def nxt(maximum: int) -> int:
            nonlocal seed
            seed = (seed * 1_103_515_245 + 12_345) & 0x7FFFFFFF
            return seed % maximum

        for _ in range(2_000):
            total = money(nxt(50_000_000), "NGN")
            count = 1 + nxt(5)
            shares: list[Share] = []
            budget = BASIS_POINTS_TOTAL
            for p in range(count):
                if budget <= 0:
                    break
                share = nxt(budget + 1)
                budget -= share
                shares.append(Share(f"p{p}", share))

            result = split_by_basis_points(total, shares)
            paid = sum(part.amount.amount for part in result.parts)
            self.assertEqual(
                paid + result.remainder.amount,
                total.amount,
                f"lost or invented value: total={total.amount} shares={shares}",
            )
            self.assertGreaterEqual(result.remainder.amount, 0)


class TestRedactFreeText(unittest.TestCase):
    def test_masks_bvn_but_keeps_it_correlatable(self) -> None:
        out = redact(f"verification failed for bvn {BVN}")
        self.assertNotIn(BVN, out)
        self.assertRegex(out, r"22\*+222")

    def test_masks_nin_and_account_number(self) -> None:
        out = redact(f"nin {NIN} account {ACCOUNT}")
        self.assertNotIn(NIN, out)
        self.assertNotIn(ACCOUNT, out)

    def test_masks_every_provider_key_format(self) -> None:
        cases = [
            ("sk_test_abc123def456", "sk_test_"),
            ("sk_live_EXAMPLEdef456", "sk_live_"),
            ("sandbox_sk_abc123def456", "sandbox_sk_"),
            ("FLWSECK_TEST-abc123def456-X", "FLWSECK_TEST-"),
            ("FLWSECK-EXAMPLEdef456", "FLWSECK-"),
            ("MK_TEST_GC3B8XG2XX", "MK_TEST_"),
            ("Bearer abc123def456ghi", "Bearer "),
        ]
        for secret, prefix in cases:
            out = redact(f"request used {secret} for auth")
            self.assertNotIn(secret, out, f"key leaked: {out}")
            self.assertIn(prefix, out, f"prefix lost: {out}")
            self.assertIn("[redacted]", out)

    def test_masks_card_number(self) -> None:
        out = redact("pan 4242424242424242 declined")
        self.assertNotIn("4242424242424242", out)
        self.assertIn("[redacted]", out)

    def test_leaves_ordinary_text_alone(self) -> None:
        self.assertEqual(
            redact("transaction failed with code 404"), "transaction failed with code 404"
        )
        self.assertEqual(redact("amount 15000 kobo"), "amount 15000 kobo")

    def test_handles_empty_and_non_string(self) -> None:
        self.assertEqual(redact(""), "")
        self.assertIsNone(redact(None))


class TestRedactObject(unittest.TestCase):
    def test_masks_sensitive_fields_and_keeps_the_rest(self) -> None:
        payload = {
            "event": "charge.success",
            "reference": "order_01HQ",
            "amount": 15_000,
            "customer": {"email": "ada@example.com", "phone": "+2348100000000", "bvn": BVN},
            "account": {"accountNumber": ACCOUNT, "bankCode": "058"},
            "secretKey": "sk_live_EXAMPLEdef456",
            "authorization": "Bearer abc123def456ghi",
        }
        out = redact_object(payload)
        serialised = json.dumps(out)

        self.assertEqual(out["event"], "charge.success")
        self.assertEqual(out["reference"], "order_01HQ")
        self.assertEqual(out["amount"], 15_000)
        self.assertEqual(out["account"]["bankCode"], "058")
        self.assertEqual(out["customer"]["email"], "ada@example.com")

        self.assertEqual(out["secretKey"], "[redacted]")
        self.assertEqual(out["authorization"], "[redacted]")
        self.assertNotIn(BVN, serialised)
        self.assertNotIn(ACCOUNT, serialised)
        self.assertNotIn("sk_live_EXAMPLEdef456", serialised)

    def test_field_names_regardless_of_case_or_separator(self) -> None:
        out = redact_object(
            {
                "secret_key": "sk_live_EXAMPLEaaaaaa",
                "SECRET-KEY": "sk_live_EXAMPLEbbbbbb",
                "accountNumber": ACCOUNT,
                "account_number": ACCOUNT,
            }
        )
        self.assertEqual(out["secret_key"], "[redacted]")
        self.assertEqual(out["SECRET-KEY"], "[redacted]")
        self.assertNotIn(ACCOUNT, json.dumps(out))

    def test_catches_sensitive_value_in_unremarkable_field(self) -> None:
        out = redact_object({"reason": f"BVN {BVN} does not match account {ACCOUNT}"})
        self.assertNotIn(BVN, json.dumps(out))
        self.assertNotIn(ACCOUNT, json.dumps(out))

    def test_walks_lists_and_survives_cycles(self) -> None:
        cyclic: dict[str, object] = {"bvn": BVN}
        cyclic["self"] = cyclic
        out = redact_object(
            {"items": [{"bvn": BVN}, {"accountNumber": ACCOUNT}], "cyclic": cyclic}
        )
        self.assertNotIn(BVN, json.dumps(out))
        self.assertEqual(out["cyclic"]["self"], "[circular]")

    def test_does_not_mutate_input(self) -> None:
        original = {"bvn": BVN, "nested": {"secretKey": "sk_live_EXAMPLEdef456"}}
        redact_object(original)
        self.assertEqual(original["bvn"], BVN)
        self.assertEqual(original["nested"]["secretKey"], "sk_live_EXAMPLEdef456")


class TestMaskingHelpers(unittest.TestCase):
    def test_keeps_the_ends(self) -> None:
        self.assertEqual(mask_account_number(ACCOUNT), "012****789")
        self.assertEqual(mask_identity_number(BVN), "222*****222")

    def test_masks_short_value_entirely(self) -> None:
        self.assertEqual(mask_account_number("12345"), "*****")


class TestKeyEnvironmentDetection(unittest.TestCase):
    def test_recognises_live_keys(self) -> None:
        self.assertTrue(looks_like_live_key("sk_live_EXAMPLE123"))
        self.assertTrue(looks_like_live_key("FLWSECK-EXAMPLE123"))
        self.assertTrue(looks_like_live_key("MK_PROD_EXAMPLE123"))
        self.assertFalse(looks_like_live_key("sk_test_abc123"))
        self.assertFalse(looks_like_live_key("FLWSECK_TEST-abc123"))

    def test_recognises_test_keys(self) -> None:
        self.assertTrue(looks_like_test_key("sk_test_abc123"))
        self.assertTrue(looks_like_test_key("sandbox_sk_abc123"))
        self.assertTrue(looks_like_test_key("FLWSECK_TEST-abc123"))
        self.assertTrue(looks_like_test_key("MK_TEST_GC3B8XG2XX"))
        self.assertFalse(looks_like_test_key("sk_live_EXAMPLE123"))

    def test_key_is_never_both(self) -> None:
        for key in (
            "sk_test_abc123",
            "sk_live_EXAMPLE123",
            "FLWSECK_TEST-abc123",
            "FLWSECK-EXAMPLE123",
            "MK_TEST_abc",
            "MK_PROD_EXAMPLE",
            "sandbox_sk_abc123",
        ):
            self.assertFalse(
                looks_like_live_key(key) and looks_like_test_key(key),
                f"{key} was classified as both test and live",
            )


class TestErrors(unittest.TestCase):
    def test_redacts_at_construction(self) -> None:
        err = NaijaPayError(
            f"failed for bvn {BVN} with key sk_live_EXAMPLEdef456",
            provider="paystack",
            operation="virtual_accounts.create_static",
        )
        for text in (str(err), repr(err), err.message, json.dumps(err.to_dict())):
            self.assertNotIn(BVN, text)
            self.assertNotIn("sk_live_EXAMPLEdef456", text)

    def test_redacts_provider_message(self) -> None:
        err = NaijaPayError("failed", provider_message=f"account {ACCOUNT} invalid")
        self.assertNotIn(ACCOUNT, str(err.provider_message))

    def test_preserves_provider_code_for_support(self) -> None:
        err = NaijaPayError("failed", provider_code="insufficient_funds", http_status=400)
        self.assertEqual(err.provider_code, "insufficient_funds")
        self.assertEqual(err.http_status, 400)

    def test_retryable_flags(self) -> None:
        self.assertTrue(NetworkError("timeout").retryable)
        self.assertTrue(RateLimitedError("slow down").retryable)
        self.assertTrue(ProviderDownError("502").retryable)
        self.assertFalse(ValidationError("bad field").retryable)
        self.assertFalse(DuplicateReferenceError("seen").retryable)
        self.assertFalse(AuthenticationError("bad key").retryable)

    def test_payout_status_unknown_is_never_retryable(self) -> None:
        # The whole point: retrying could pay twice.
        err = PayoutStatusUnknownError("unknown", reference="payout_01HQ")
        self.assertFalse(err.retryable)
        self.assertEqual(err.reference, "payout_01HQ")

    def test_validation_error_redacts_field_messages(self) -> None:
        err = ValidationError("invalid", fields={"bvn": f"{BVN} is not valid"})
        self.assertNotIn(BVN, json.dumps(err.fields))

    def test_kyc_required_lists_fields_not_values(self) -> None:
        err = KycRequiredError("bvn needed", required=["bvn"], current_tier=1)
        self.assertEqual(err.required, ("bvn",))
        self.assertEqual(err.current_tier, 1)
        self.assertNotIn(BVN, str(err))

    def test_unsupported_operation_message(self) -> None:
        err = UnsupportedOperationError(
            provider="paystack",
            operation="wallets.open",
            reason="Paystack has no wallet product.",
        )
        self.assertIn("paystack does not support wallets.open", str(err))

    def test_status_mapping(self) -> None:
        self.assertIs(error_class_for_status(401), AuthenticationError)
        self.assertIs(error_class_for_status(409), DuplicateReferenceError)
        self.assertIs(error_class_for_status(429), RateLimitedError)
        self.assertIs(error_class_for_status(503), ProviderDownError)


if __name__ == "__main__":
    unittest.main()
