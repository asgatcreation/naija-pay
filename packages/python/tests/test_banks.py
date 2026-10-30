"""Bank matching tests, mirroring packages/ts/test/banks.test.ts."""

import pathlib
import re
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "src"))

from naija_pay.core.banks import (  # noqa: E402
    bank_data_source,
    coverage_for,
    institution_by_id,
    institutions,
    match_institution,
    merger_warning_for,
    normalise_bank_name,
    unverified_codes_for,
)


class TestDataset(unittest.TestCase):
    def test_carries_cc_by_attribution(self) -> None:
        source = bank_data_source()
        self.assertIn("naija-data", source.attribution)
        self.assertEqual(source.licence, "CC-BY-4.0")
        self.assertRegex(source.data_version, r"^\d{4}-\d{2}-\d{2}$")

    def test_only_payable_institutions(self) -> None:
        all_institutions = institutions()
        self.assertGreater(len(all_institutions), 800)
        for institution in all_institutions:
            self.assertIn(
                institution.status,
                ("active", "merged"),
                f"{institution.id}: revoked and defunct must be dropped",
            )


class TestNameNormalisation(unittest.TestCase):
    def test_collapses_spellings(self) -> None:
        self.assertEqual(normalise_bank_name("Guaranty Trust Bank Plc"), "guaranty trust")
        self.assertEqual(normalise_bank_name("Access Bank Plc"), "access")
        self.assertEqual(normalise_bank_name("ACCESS BANK"), "access")
        self.assertEqual(normalise_bank_name("First Bank of Nigeria Limited"), "first of")
        self.assertEqual(normalise_bank_name("Stanbic IBTC Bank"), "stanbic ibtc")

    def test_expands_ampersand(self) -> None:
        self.assertEqual(
            normalise_bank_name("Taj & Co Bank"), normalise_bank_name("Taj and Bank")
        )


class TestMatching(unittest.TestCase):
    def test_matches_cbn_code(self) -> None:
        match = match_institution(code="044", name="Access Bank")
        assert match is not None
        self.assertEqual(match.institution.id, "access-bank")
        self.assertEqual(match.matched_by, "cbn_code")

    def test_matches_nip_code(self) -> None:
        match = match_institution(code="000014")
        assert match is not None
        self.assertEqual(match.institution.id, "access-bank")
        self.assertEqual(match.matched_by, "nip_code")

    def test_matches_name_and_distinguishes_alias(self) -> None:
        official = match_institution(name="Guaranty Trust Bank Plc")
        alias = match_institution(name="GTBank")
        assert official is not None and alias is not None
        self.assertEqual(official.matched_by, "name")
        self.assertEqual(alias.matched_by, "alias")
        self.assertEqual(official.institution.id, alias.institution.id)

    def test_prefers_code_over_name(self) -> None:
        match = match_institution(code="044", name="Something Else Entirely")
        assert match is not None
        self.assertEqual(match.institution.id, "access-bank")
        self.assertEqual(match.matched_by, "cbn_code")

    def test_ignores_implausible_code_shapes(self) -> None:
        # Paystack returns codes like "MFB50094" and "035A". Matching those against a
        # NIP code would be coincidence, not fact.
        self.assertIsNone(match_institution(code="MFB50094"))
        self.assertIsNone(match_institution(code="035A"))
        self.assertIsNone(match_institution(code="1234567890"))

    def test_returns_none_rather_than_guessing(self) -> None:
        self.assertIsNone(match_institution(name="Definitely Not A Real Bank Zzz"))
        self.assertIsNone(match_institution())


class TestMergedInstitutions(unittest.TestCase):
    def test_merged_bank_matchable_by_old_code_and_warns(self) -> None:
        # Paystack really does list "Access Bank (Diamond)" under Diamond's 063.
        match = match_institution(code="063", name="Access Bank (Diamond)")
        assert match is not None
        self.assertEqual(match.institution.id, "diamond-bank")

        warning = merger_warning_for(match.institution)
        assert warning is not None
        assert warning.merged_into is not None
        self.assertEqual(warning.merged_into.id, "access-bank")
        self.assertIn("merged into Access Bank", warning.message)
        self.assertIn("confirm the destination before settling", warning.message)

    def test_active_code_wins(self) -> None:
        match = match_institution(code="044")
        assert match is not None
        self.assertEqual(match.institution.id, "access-bank")
        self.assertEqual(match.institution.status, "active")
        self.assertIsNone(merger_warning_for(match.institution))

    def test_every_merger_target_exists(self) -> None:
        for institution in institutions():
            if institution.status != "merged":
                continue
            warning = merger_warning_for(institution)
            assert warning is not None, f"{institution.id} is merged but produced no warning"
            self.assertIsNotNone(
                warning.merged_into,
                f"{institution.id} merged into {institution.merged_into}, which is absent",
            )


class TestUnverifiedCodes(unittest.TestCase):
    def test_surfaces_upstream_unverified_flags(self) -> None:
        flagged = [i for i in institutions() if unverified_codes_for(i)]
        self.assertGreater(len(flagged), 0)
        for institution in flagged:
            for field in unverified_codes_for(institution):
                self.assertIn(field, ("cbnCode", "nipCode"), f"{institution.id}: {field}")


class TestCoverageReporting(unittest.TestCase):
    def test_counts_by_method_and_lists_misses(self) -> None:
        report = coverage_for(
            "testprovider",
            [
                {"code": "044", "name": "Access Bank"},
                {"code": "000014", "name": "Access Bank"},
                {"name": "GTBank"},
                {"code": "MFB50094", "name": "Some Unknown MFB Ltd Zzz"},
            ],
        )
        self.assertEqual(report.provider, "testprovider")
        self.assertEqual(report.total, 4)
        self.assertEqual(report.matched, 3)
        self.assertEqual(report.by_method["cbn_code"], 1)
        self.assertEqual(report.by_method["nip_code"], 1)
        self.assertEqual(report.by_method["alias"], 1)
        self.assertEqual(len(report.unmatched), 1)
        self.assertEqual(report.unmatched[0]["code"], "MFB50094")

    def test_empty_list(self) -> None:
        report = coverage_for("empty", [])
        self.assertEqual(report.total, 0)
        self.assertEqual(report.matched, 0)
        self.assertEqual(len(report.unmatched), 0)


class TestLookupById(unittest.TestCase):
    def test_known_and_unknown(self) -> None:
        found = institution_by_id("access-bank")
        assert found is not None
        self.assertEqual(found.name, "Access Bank Plc")
        self.assertIsNone(institution_by_id("no-such-bank"))


if __name__ == "__main__":
    unittest.main()
