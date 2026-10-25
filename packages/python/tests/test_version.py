"""Scaffold tests. These run with the standard library alone, so they need no installs."""

import pathlib
import re
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "src"))

import naija_pay  # noqa: E402

PYPROJECT = pathlib.Path(__file__).resolve().parents[1] / "pyproject.toml"


def declared_version() -> str:
    """Read the version from pyproject.toml without needing a TOML parser."""
    text = PYPROJECT.read_text(encoding="utf-8")
    match = re.search(r'^version\s*=\s*"([^"]+)"', text, re.MULTILINE)
    assert match is not None, "no version found in pyproject.toml"
    return match.group(1)


class TestVersion(unittest.TestCase):
    def test_version_matches_pyproject(self) -> None:
        self.assertEqual(naija_pay.__version__, declared_version())

    def test_only_httpx_is_a_runtime_dependency(self) -> None:
        text = PYPROJECT.read_text(encoding="utf-8")
        match = re.search(r"^dependencies\s*=\s*\[(.*?)\]", text, re.MULTILINE | re.DOTALL)
        assert match is not None, "no dependencies array found in pyproject.toml"
        names = re.findall(r'"([A-Za-z0-9_.-]+)', match.group(1))
        self.assertEqual(
            names,
            ["httpx"],
            "naija-pay must depend on httpx alone at runtime",
        )


class TestSignatureStrength(unittest.TestCase):
    def test_all_four_strengths_are_declared(self) -> None:
        from typing import get_args

        self.assertEqual(
            set(get_args(naija_pay.SignatureStrength)),
            {"full-body", "partial-body", "shared-secret", "unverified"},
        )


if __name__ == "__main__":
    unittest.main()
