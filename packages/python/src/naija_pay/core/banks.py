"""Bank and institution matching.

Read the bank-codes section of DESIGN.md before changing anything here. The short
version, which is a money-safety rule rather than a preference:

    **The provider's own bank code is authoritative for calling that provider, and
    naija-pay never substitutes it.**

The data in this module is an *enrichment* layer from naija-data. It answers "is
Paystack's bank X the same institution as Monnify's bank Y?", supplies the canonical
name and type, and -- the two things a payout flow genuinely benefits from -- says when
an institution has been **merged into another**, and when a code naija-data carries is
**unverified upstream**.

It is deliberately not a code lookup table. Measured on 2026-10-26, naija-data has a NIP
code for only 49 of 898 institutions, while Paystack alone returns 292 Nigerian banks
under its own codes in three different lengths. Matching is therefore best-effort, every
match records how it was made, and misses are reported rather than guessed at.

Mirrors ``packages/ts/src/core/banks.py``.
"""

from __future__ import annotations

import json
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from functools import lru_cache
from importlib import resources
from typing import Any, Literal, cast

InstitutionType = Literal[
    "commercial",
    "merchant",
    "non_interest",
    "payment_service_bank",
    "mobile_money_operator",
    "microfinance",
    "mortgage",
    "development_finance",
]

MatchedBy = Literal["nip_code", "cbn_code", "name", "alias"]


@dataclass(frozen=True, slots=True)
class Institution:
    #: Canonical, stable identifier from naija-data, e.g. "access-bank".
    id: str
    name: str
    type: str
    status: Literal["active", "merged"]
    short_name: str | None = None
    #: NIBSS 6-digit code, where naija-data has one.
    nip_code: str | None = None
    #: CBN 3- or 5-digit code, where naija-data has one.
    cbn_code: str | None = None
    #: Where a merged institution went. Providers still return merged banks' codes.
    merged_into: str | None = None
    aliases: tuple[str, ...] = ()
    #: Codes naija-data could not verify against a primary source.
    unverified: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class BankDataSource:
    repository: str
    file: str
    data_version: str
    licence: str
    attribution: str


@dataclass(frozen=True, slots=True)
class InstitutionMatch:
    institution: Institution
    #: How the match was made, so a weak match is visible rather than assumed.
    matched_by: MatchedBy


_SUFFIXES = re.compile(r"\b(plc|limited|ltd|nigeria|ng|company|co)\b")
_BANK_WORDS = re.compile(r"\b(bank|banks|banking)\b")
_NON_ALNUM = re.compile(r"[^a-z0-9]+")
_SPACES = re.compile(r"\s+")


def normalise_bank_name(name: str) -> str:
    """Normalise a bank name for comparison.

    Providers spell the same institution many ways: "Guaranty Trust Bank", "GTBank",
    "GTB", "Guaranty Trust Bank Plc". Corporate suffixes and the word "bank" carry no
    distinguishing information, so they are dropped -- "Access Bank Plc" and "Access"
    then agree.
    """
    out = name.lower().replace("&", " and ")
    out = _NON_ALNUM.sub(" ", out)
    out = _SUFFIXES.sub(" ", out)
    out = _BANK_WORDS.sub(" ", out)
    return _SPACES.sub(" ", out).strip()


def _load_raw() -> dict[str, Any]:
    text = resources.files("naija_pay._data").joinpath("banks.json").read_text(encoding="utf-8")
    # json.loads is Any; the shape is guaranteed by tools/check-generated-data.mjs,
    # which CI runs on every push.
    return cast(dict[str, Any], json.loads(text))


@dataclass(frozen=True, slots=True)
class _Index:
    source: BankDataSource
    institutions: tuple[Institution, ...]
    by_id: Mapping[str, Institution]
    by_nip_code: Mapping[str, Institution]
    by_cbn_code: Mapping[str, Institution]
    by_name: Mapping[str, Institution]


@lru_cache(maxsize=1)
def _index() -> _Index:
    raw = _load_raw()
    src = raw["source"]
    source = BankDataSource(
        repository=src["repository"],
        file=src["file"],
        data_version=src["dataVersion"],
        licence=src["licence"],
        attribution=src["attribution"],
    )

    institutions: list[Institution] = []
    by_id: dict[str, Institution] = {}
    by_nip: dict[str, Institution] = {}
    by_cbn: dict[str, Institution] = {}
    by_name: dict[str, Institution] = {}

    for entry in raw["banks"]:
        institution = Institution(
            id=entry["id"],
            name=entry["name"],
            type=entry["type"],
            status=entry["status"],
            short_name=entry.get("shortName"),
            nip_code=entry.get("nipCode"),
            cbn_code=entry.get("cbnCode"),
            merged_into=entry.get("mergedInto"),
            aliases=tuple(entry.get("aliases", ())),
            unverified=tuple(entry.get("unverified", ())),
        )
        institutions.append(institution)
        by_id[institution.id] = institution
        for candidate in (institution.name, institution.short_name, *institution.aliases):
            if not candidate:
                continue
            key = normalise_bank_name(candidate)
            # First writer wins, so a commercial bank is not displaced by a microfinance
            # bank with a similar name. The file is sorted by id, making that
            # deterministic.
            if key and key not in by_name:
                by_name[key] = institution

    # Active institutions are indexed first and win any collision. Merged ones are
    # indexed afterwards only where their code is still free -- providers really do keep
    # serving the old codes (Paystack lists "Access Bank (Diamond)" under Diamond's
    # 063), and matching them is what makes the merger warning reachable instead of
    # decorative.
    for pass_status in ("active", "merged"):
        for institution in institutions:
            if institution.status != pass_status:
                continue
            if institution.nip_code and institution.nip_code not in by_nip:
                by_nip[institution.nip_code] = institution
            if institution.cbn_code and institution.cbn_code not in by_cbn:
                by_cbn[institution.cbn_code] = institution

    return _Index(
        source=source,
        institutions=tuple(institutions),
        by_id=by_id,
        by_nip_code=by_nip,
        by_cbn_code=by_cbn,
        by_name=by_name,
    )


def institutions() -> tuple[Institution, ...]:
    """Every institution naija-data carries that can still receive money."""
    return _index().institutions


def bank_data_source() -> BankDataSource:
    """Provenance, including the CC BY 4.0 attribution naija-data requires.

    Exposed so an application that displays bank data can honour the licence.
    """
    return _index().source


def institution_by_id(institution_id: str) -> Institution | None:
    """Look an institution up by its canonical naija-data id."""
    return _index().by_id.get(institution_id)


_SIX_DIGITS = re.compile(r"^\d{6}$")
_CBN_SHAPES = re.compile(r"^\d{3}$|^\d{5}$")


def match_institution(
    *, code: str | None = None, name: str | None = None
) -> InstitutionMatch | None:
    """Best-effort match for a bank as some provider described it.

    Codes are tried first and only against the length they can plausibly be -- a 6-digit
    code is a NIP code, a 3- or 5-digit code is a CBN code. A provider code of any other
    length is that provider's own identifier and is not looked up at all, because
    matching it against a NIP code would be a coincidence rather than a fact.

    Returns ``None`` rather than guessing. An unmatched bank is still perfectly usable:
    the provider's code remains authoritative.
    """
    index = _index()

    if code:
        trimmed = code.strip()
        if _SIX_DIGITS.match(trimmed):
            hit = index.by_nip_code.get(trimmed)
            if hit:
                return InstitutionMatch(institution=hit, matched_by="nip_code")
        if _CBN_SHAPES.match(trimmed):
            hit = index.by_cbn_code.get(trimmed)
            if hit:
                return InstitutionMatch(institution=hit, matched_by="cbn_code")

    if name:
        key = normalise_bank_name(name)
        hit = index.by_name.get(key)
        if hit:
            # Distinguish a hit on the official name from one on an alias or short name,
            # so the caller can tell how confident the match is.
            official = normalise_bank_name(hit.name) == key
            return InstitutionMatch(institution=hit, matched_by="name" if official else "alias")

    return None


@dataclass(frozen=True, slots=True)
class MergerWarning:
    institution: Institution
    merged_into: Institution | None
    message: str


def merger_warning_for(institution: Institution) -> MergerWarning | None:
    """If this institution has been merged into another, describe it.

    Worth surfacing before a payout: providers still return merged institutions' codes,
    and a developer settling to one deserves to know the bank no longer exists on its
    own.
    """
    if institution.status != "merged" or not institution.merged_into:
        return None
    target = institution_by_id(institution.merged_into)
    target_name = target.name if target else institution.merged_into
    return MergerWarning(
        institution=institution,
        merged_into=target,
        message=(
            f"{institution.name} has been merged into {target_name}. Providers may "
            "still return its old code; confirm the destination before settling."
        ),
    )


def unverified_codes_for(institution: Institution) -> tuple[str, ...]:
    """Which of an institution's codes naija-data could not verify upstream."""
    return institution.unverified


@dataclass(frozen=True, slots=True)
class CoverageReport:
    provider: str
    total: int
    matched: int
    by_method: Mapping[str, int]
    unmatched: tuple[Mapping[str, Any], ...]


def coverage_for(provider: str, banks: Sequence[Mapping[str, Any]]) -> CoverageReport:
    """How much of a provider's bank list can be matched to an institution.

    Unmatched banks are a naija-data issue to fix, not a reason to fail a build -- which
    is why this returns a report instead of raising.
    """
    by_method: dict[str, int] = {"nip_code": 0, "cbn_code": 0, "name": 0, "alias": 0}
    unmatched: list[Mapping[str, Any]] = []

    for bank in banks:
        match = match_institution(code=bank.get("code"), name=bank.get("name"))
        if match:
            by_method[match.matched_by] += 1
        else:
            unmatched.append(bank)

    return CoverageReport(
        provider=provider,
        total=len(banks),
        matched=len(banks) - len(unmatched),
        by_method=by_method,
        unmatched=tuple(unmatched),
    )


__all__: Sequence[str] = [
    "BankDataSource",
    "CoverageReport",
    "Institution",
    "InstitutionMatch",
    "InstitutionType",
    "MatchedBy",
    "MergerWarning",
    "bank_data_source",
    "coverage_for",
    "institution_by_id",
    "institutions",
    "match_institution",
    "merger_warning_for",
    "normalise_bank_name",
    "unverified_codes_for",
]
