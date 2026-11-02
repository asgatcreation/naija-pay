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

- HTTP layer that decides retries by the operation rather than the error: every request
  declares its safety, and a money-moving request is never retried. In TypeScript `fetch` is
  injectable; in Python the retry and backoff logic is pure stdlib behind a `Transport` protocol
  with httpx imported lazily, so both are testable offline.
- Capability declarations, so an unsupported operation fails locally before any network call, and
  features gated behind a provider's commercial approval are marked as such.
- All eight documented webhook signature schemes, verified over raw bytes with constant-time
  comparison and an honest strength rating. TypeScript uses WebCrypto rather than `node:crypto`
  so the same code runs on Node, Bun, Deno and edge runtimes. Undocumented schemes refuse to be
  computed rather than guessed.
- Bank matching over the naija-data dataset, with merger warnings, upstream verification flags,
  and a coverage report (`npm run report:banks`).
- Normalised event vocabulary, and the inflow rules: overpayment, underpayment, late payment and
  duplicate delivery are each a named, configurable rule, with conservative defaults. A duplicate
  is always ignored and that is deliberately not configurable.
- Mock provider for both languages: signs real webhooks with a real scheme, covers every inflow
  edge case, replays events to exercise duplicate handling, and can emit a deliberately invalid
  signature. Needs no keys and reaches no network.

- **Paystack adapter** in both languages, from 13 fixtures recorded out of Paystack's own documented
  samples: checkout, verification, transaction listing, refunds, dedicated virtual accounts,
  subaccounts, transaction splits, payouts with recipient creation, account resolution, balance and
  webhook verification. It refuses to construct when a live key is paired with
  `environment: "test"`, validates Paystack's strict transfer-reference format locally, reports an
  OTP-gated transfer as pending rather than successful, and keeps `requested_amount` and `amount`
  apart as `amount` and `amountPaid`. `wallets.*` is absent deliberately: Paystack has no product
  that opens a deposit account holding a balance.

- Paystack **sandbox-verified** on 2026-10-30, and the run changed the code. It established that
  `/subaccount` accepts `bank_code` alone, `settlement_bank` alone or both, settling a
  contradiction in Paystack's own documentation; that basis points convert exactly; and three things
  the documentation does not mention — Dedicated Virtual Accounts must be enabled per business, an
  empty balance reads "Your balance is not enough to fulfil this request", and test mode allows only
  three live bank resolves a day. The error classifier and capability declarations were corrected
  accordingly, and the observed responses are recorded as fixtures. The Python adapter made its first
  real HTTP calls over httpx in the process.

- Settled on a funded sandbox balance: **Paystack transfer OTP is enabled by default**, so every
  payout halts for a human until "Confirm transfers before sending" is unchecked on the dashboard.
  The adapter reports this as `pending` with `awaitingOtp` rather than success. The sandbox harness
  now distinguishes a probe _blocked by account configuration_ from a genuine failure, so the weekly
  drift workflow will not cry wolf over features Paystack has not enabled.

- **Flutterwave adapter** in both languages, from 15 fixtures recorded out of Flutterwave's own
  documented samples: hosted checkout, verification by id and by reference, transaction listing,
  refunds, static and dynamic virtual accounts, collection subaccounts, split declarations, payout
  subaccount wallets, payouts, wallet transfers, account resolution, bank listing and balances.
  It is the first adapter to support `wallets.*`: Flutterwave's payout subaccounts are real NGN
  wallets with their own NUBAN, which Paystack has no product for. It is also the first to support
  `virtualAccounts.createDynamic`.

- **The Flutterwave adapter speaks v3 for every operation, and v4 only for webhook verification.**
  Reading both references endpoint by endpoint settled a question milestone 1 had left open and
  corrected two things it had got wrong. v4 has gained virtual accounts, but it still has no split
  payments and no payout subaccounts — and, decisively, no hosted checkout: a v4 collection requires
  a `payment_method_id`, which for a card means holding the card number. naija-pay does not do that,
  so v4 collections are out of scope by policy. Straddling both generations would have bought two
  credential sets and two token lifecycles for a surface missing half of what this SDK normalises.
  v4's real idempotency keys and scenario-key sandbox are recorded in PROVIDERS.md as the next step
  rather than half-built.

- `toMajor` and `basisPointsToFraction` in `core/money`, for providers whose wire format is not
  minor units. Flutterwave is the first: it sends and accepts decimals in major units, so `5000`
  means five thousand naira and a balance arrives as `20000.5`. Converting through a float is where
  money quietly goes missing — `1200.09 * 100` is `120008.99999999999` and `3.29 * 100` is
  `328.99999999999994` — so both functions round the scaled integer and then assert the round trip,
  refusing outright rather than shipping a wrong number. Flutterwave also states percentage splits
  as decimal fractions (9% is `0.09`), so basis points convert in one tested place instead of at
  each call site. A test walks every kobo value up to NGN 1,000; parity cases pin both directions
  and both rejection messages across the two languages. See the new section in DESIGN.md.

- Three Flutterwave behaviours the adapter absorbs so an application never meets them: a created
  payout returns `"status": "success"` at the envelope level with `data.status` of `"NEW"`, meaning
  **queued, not sent**, and is reported as pending; v3 signals failures with `"status": "error"`
  inside a 200 response, so the envelope is checked on every call; and the literal string `"N/A"`
  appears where a field does not apply, which would otherwise parse into an Invalid Date and a NaN
  amount. A transfer awaiting dashboard approval reports `awaitingApproval`, for the same reason
  Paystack's OTP gate reports `awaitingOtp`.

- Flutterwave webhook verification accepting **both** schemes and reporting which one it used. A v4
  `flutterwave-signature` is a real HMAC-SHA256 over the raw body and verifies as `full-body`; a v3
  `verif-hash` carries the secret hash verbatim, proves nothing about the payload, and is reported
  as `shared-secret` rather than dressed up as a signature. A test asserts the v3 header
  authenticates a tampered body just as happily as the original, because that is the security
  property `signatureStrength` exists to expose. v4 is preferred when both headers arrive.

### Fixed

- `toMajor` would emit `0.01` XOF — an amount its own inverse refuses, and one a provider would
  silently drop the fraction of, since XOF has no subunit. `fromMajor` had always refused it. The
  two directions were tested separately and each passed; only the cross-language parity cases,
  comparing both directions at once, exposed the asymmetry. Fixed in both languages with identical
  messages and regression-tested.

### Changed

- **Bank codes are no longer normalised onto a single CBN/NIBSS code.** Measuring the real data
  showed naija-data carries a NIP code for only 49 of 898 institutions, while Paystack alone
  returns 292 Nigerian banks under codes of its own in three different lengths. The provider's own
  bank code is now authoritative and is never substituted; naija-data supplies institution
  identity, merger status and verification flags as enrichment. See the bank-codes section of
  DESIGN.md.
