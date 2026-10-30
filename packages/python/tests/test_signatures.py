"""Signature tests, mirroring packages/ts/test/signatures.test.ts.

The expected values are fixed test vectors. The TypeScript implementation uses WebCrypto
and this one uses hashlib, so both matching the same strings is a genuine
cross-implementation check rather than two copies of one mistake.
"""

import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "src"))

from naija_pay.core.signatures import (  # noqa: E402
    SCHEMES,
    compute_signature,
    constant_time_equal,
    strength_of,
    verify_signature,
)

BODY = b'{"event":"charge.success","data":{"reference":"order_01HQ","amount":15000}}'
SECRET = "sk_test_EXAMPLE123"

PAYSTACK_SIG = (
    "ae20cd85e078d89a2c18be44c76488e6b4556228d4e6f032957732b6a5d2356896ad714b"
    "2adadc5657a2da91b4d074d51ff1e680ae8e8a0aad2cf32299708662"
)
FLUTTERWAVE_V4_SIG = "XEDJlTlj6fd4EVPlEYlFFuWrAyNPYdAvIHR0FUvtkyo="
KORAPAY_SIG = "3b6a799ba264a76caa47d990430a2b638c4c66506ee46ee13cf85f65ca707499"
ANCHOR_SIG = "NjAxMDNhZjhlMDgxYjhlZTM0OGMyZDQwZjRiZjhhYjg0NmRhMDFmZA=="


class TestComputingSignatures(unittest.TestCase):
    def test_paystack_sha512_hex_over_raw_body(self) -> None:
        self.assertEqual(compute_signature(SCHEMES["paystack"], BODY, SECRET), PAYSTACK_SIG)

    def test_fincra_same_algorithm_different_key(self) -> None:
        # Identical algorithm, so the digest matches; the difference is which key you
        # use, which is exactly the trap this records.
        self.assertEqual(compute_signature(SCHEMES["fincra"], BODY, SECRET), PAYSTACK_SIG)

    def test_flutterwave_v4_sha256_base64(self) -> None:
        self.assertEqual(
            compute_signature(SCHEMES["flutterwaveV4"], BODY, SECRET), FLUTTERWAVE_V4_SIG
        )

    def test_korapay_signs_data_object_only(self) -> None:
        self.assertEqual(compute_signature(SCHEMES["korapay"], BODY, SECRET), KORAPAY_SIG)
        # Proof it really is the sub-object: it must differ from the full-body digest.
        self.assertNotEqual(KORAPAY_SIG, PAYSTACK_SIG)

    def test_anchor_base64_of_hex_sha1(self) -> None:
        self.assertEqual(compute_signature(SCHEMES["anchor"], BODY, SECRET), ANCHOR_SIG)

    def test_flutterwave_v3_echoes_the_shared_secret(self) -> None:
        # Recorded as a test because it is the whole problem: the value does not depend
        # on the body at all.
        self.assertEqual(compute_signature(SCHEMES["flutterwaveV3"], BODY, SECRET), SECRET)
        self.assertEqual(
            compute_signature(SCHEMES["flutterwaveV3"], b'{"event":"anything.else"}', SECRET),
            SECRET,
        )

    def test_refuses_to_invent_an_undocumented_signature(self) -> None:
        for name in ("squad", "monnify"):
            with self.assertRaises(ValueError) as ctx:
                compute_signature(SCHEMES[name], BODY, SECRET)
            self.assertIn("undocumented", str(ctx.exception))


class TestVerifyingSignatures(unittest.TestCase):
    def test_accepts_correct_signatures_with_honest_strength(self) -> None:
        cases = [
            ("paystack", PAYSTACK_SIG),
            ("flutterwaveV4", FLUTTERWAVE_V4_SIG),
            ("korapay", KORAPAY_SIG),
            ("anchor", ANCHOR_SIG),
        ]
        for name, signature in cases:
            scheme = SCHEMES[name]
            result = verify_signature(
                scheme=scheme,
                body=BODY,
                headers={scheme.header: signature},
                secret=SECRET,
            )
            self.assertTrue(result.verified, f"{name}: {result.reason}")
            self.assertEqual(result.strength, scheme.strength)

    def test_rejects_tampered_body(self) -> None:
        tampered = b'{"event":"charge.success","data":{"reference":"order_01HQ","amount":9900000}}'
        result = verify_signature(
            scheme=SCHEMES["paystack"],
            body=tampered,
            headers={"x-paystack-signature": PAYSTACK_SIG},
            secret=SECRET,
        )
        self.assertFalse(result.verified)
        self.assertIn("did not match", result.reason or "")

    def test_rejects_wrong_secret(self) -> None:
        result = verify_signature(
            scheme=SCHEMES["paystack"],
            body=BODY,
            headers={"x-paystack-signature": PAYSTACK_SIG},
            secret="sk_test_EXAMPLEdifferent",
        )
        self.assertFalse(result.verified)

    def test_rejects_missing_or_empty_header(self) -> None:
        for headers in ({}, {"x-paystack-signature": ""}):
            result = verify_signature(
                scheme=SCHEMES["paystack"], body=BODY, headers=headers, secret=SECRET
            )
            self.assertFalse(result.verified)
            self.assertEqual(result.strength, "unverified")
            self.assertIn("missing", result.reason or "")

    def test_matches_header_case_insensitively(self) -> None:
        result = verify_signature(
            scheme=SCHEMES["paystack"],
            body=BODY,
            headers={"X-Paystack-Signature": PAYSTACK_SIG},
            secret=SECRET,
        )
        self.assertTrue(result.verified)

    def test_undocumented_scheme_is_never_verified(self) -> None:
        # The important negative case. Squad sends a signature header, and it would be
        # easy to guess an algorithm and claim success. We must not.
        result = verify_signature(
            scheme=SCHEMES["squad"],
            body=BODY,
            headers={"x-squad-encrypted-body": "whatever-the-provider-sent"},
            secret=SECRET,
        )
        self.assertFalse(result.verified)
        self.assertEqual(result.strength, "unverified")
        self.assertIn("undocumented", result.reason or "")
        self.assertIn("re-verify with the API", result.reason or "")

    def test_flutterwave_v3_verifies_but_cannot_detect_forgery(self) -> None:
        result = verify_signature(
            scheme=SCHEMES["flutterwaveV3"],
            body=BODY,
            headers={"verif-hash": SECRET},
            secret=SECRET,
        )
        self.assertTrue(result.verified)
        self.assertEqual(result.strength, "shared-secret")

        forged = verify_signature(
            scheme=SCHEMES["flutterwaveV3"],
            body=b'{"event":"payment.successful","data":{"amount":99999999}}',
            headers={"verif-hash": SECRET},
            secret=SECRET,
        )
        self.assertTrue(forged.verified, "v3 cannot detect a forged payload -- the finding")
        self.assertEqual(forged.strength, "shared-secret")

    def test_refuses_body_lacking_the_signed_sub_object(self) -> None:
        # Regression test for a real bug the parity harness caught: json.dumps of a
        # missing key yields "null", which was being signed and then verified against
        # itself, accepting an unsigned event.
        body = b'{"event":"charge.success"}'
        result = verify_signature(
            scheme=SCHEMES["korapay"],
            body=body,
            headers={"x-korapay-signature": "0" * 64},
            secret=SECRET,
        )
        self.assertFalse(result.verified)
        self.assertEqual(result.strength, "unverified")
        self.assertIn('has no "data" to sign', result.reason or "")

        with self.assertRaises(ValueError) as ctx:
            compute_signature(SCHEMES["korapay"], body, SECRET)
        self.assertIn('has no "data" to sign', str(ctx.exception))

    def test_stable_message_for_non_json_body(self) -> None:
        result = verify_signature(
            scheme=SCHEMES["korapay"],
            body=b"<html>not json</html>",
            headers={"x-korapay-signature": KORAPAY_SIG},
            secret=SECRET,
        )
        self.assertFalse(result.verified)
        self.assertEqual(result.strength, "unverified")
        self.assertIn("not valid JSON", result.reason or "")

    def test_partial_body_scheme_cannot_detect_tampering_outside_signed_region(self) -> None:
        # Not a defect in naija-pay -- it is the documented consequence of Korapay
        # signing only `data`. Asserted so the weakness stays visible.
        tampered = b'{"event":"charge.failed","data":{"reference":"order_01HQ","amount":15000}}'
        result = verify_signature(
            scheme=SCHEMES["korapay"],
            body=tampered,
            headers={"x-korapay-signature": KORAPAY_SIG},
            secret=SECRET,
        )
        self.assertTrue(result.verified, "the event name is outside the signed region")
        self.assertEqual(result.strength, "partial-body")


class TestConstantTimeComparison(unittest.TestCase):
    def test_correct_results(self) -> None:
        self.assertTrue(constant_time_equal("abc", "abc"))
        self.assertFalse(constant_time_equal("abc", "abd"))
        self.assertFalse(constant_time_equal("abc", "abcd"))
        self.assertFalse(constant_time_equal("", "a"))
        self.assertTrue(constant_time_equal("", ""))


class TestDeclaredStrengthsAreHonest(unittest.TestCase):
    def test_every_declaration_matches_reality(self) -> None:
        for name, scheme in SCHEMES.items():
            self.assertEqual(
                scheme.strength,
                strength_of(scheme),
                f'{name} claims "{scheme.strength}" but gives "{strength_of(scheme)}"',
            )

    def test_the_three_weak_providers_are_marked(self) -> None:
        # The headline finding from PROVIDERS.md, asserted so it cannot be quietly
        # upgraded later without a failing test.
        self.assertEqual(SCHEMES["flutterwaveV3"].strength, "shared-secret")
        self.assertEqual(SCHEMES["korapay"].strength, "partial-body")
        self.assertEqual(SCHEMES["squad"].strength, "unverified")
        self.assertEqual(SCHEMES["monnify"].strength, "unverified")


if __name__ == "__main__":
    unittest.main()
