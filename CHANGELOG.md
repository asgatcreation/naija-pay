# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing is published to npm or PyPI yet. See [PLAN.md](PLAN.md) for the milestone schedule.

### Added

- Provider research for 25 Nigerian payment and banking-as-a-service providers, read from each
  provider's current official documentation and recorded with verification dates, in
  [PROVIDERS.md](PROVIDERS.md). Includes the capability matrix and a comparison of all eight
  webhook signing schemes.
- The normalised API contract in [DESIGN.md](DESIGN.md): money as integer minor units, typed errors,
  collections, static and dynamic virtual accounts, split-payment sub-accounts and wallet
  sub-accounts kept strictly apart, payouts, recurring billing and mandates, normalised webhook
  events with a `signatureStrength` rating, the multi-provider router with its rule that
  money-moving operations never fail over, the fee calculator, reconciliation, the mock provider
  and the CLI.
- Repository scaffold: MIT licence, README, contributing guide with the add-a-provider checklist,
  security policy with private vulnerability reporting, code of conduct, issue and PR templates,
  Dependabot, and the CI workflow.
- Workspace skeletons for the TypeScript (`packages/ts`) and Python (`packages/python`) packages,
  and the shared fixture layout both languages test against.
- Core primitives in both languages: `Money` as an integer count of minor units with exact
  integer split arithmetic, the typed error hierarchy, and automatic redaction of BVNs, NINs,
  account numbers, card numbers and every provider's credential format.
- Cross-language parity harness: 67 shared cases in `fixtures/parity/` run through both packages,
  compared byte for byte, covering amounts, split rounding, redaction, key detection and the
  exact message of every rejection.
- Bank data generated from naija-data (CC BY 4.0, attribution embedded) into
  `data/banks.generated.json`, with an offline validator that checks attribution, shape, merger
  targets and code uniqueness among active institutions.

### Changed

- **Bank codes are no longer normalised onto a single CBN/NIBSS code.** Measuring the real data
  showed naija-data carries a NIP code for only 49 of 898 institutions, while Paystack alone
  returns 292 Nigerian banks under codes of its own in three different lengths. The provider's own
  bank code is now authoritative and is never substituted; naija-data supplies institution
  identity, merger status and verification flags as enrichment. See the bank-codes section of
  DESIGN.md.
