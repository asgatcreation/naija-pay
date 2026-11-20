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

- A Flutterwave sandbox harness (`npm run sandbox:flutterwave`), built around the questions its
  documentation cannot answer: whether a fractional amount survives a real round trip unchanged,
  what status a created transfer actually carries, whether transfers need dashboard approval on a
  fresh account, whether payout subaccount wallets are enabled per merchant, and whether a
  percentage split really is a decimal fraction. It refuses to run with anything but a
  `FLWSECK_TEST-` key, skips silently when no key is set, distinguishes a probe blocked by account
  configuration from a genuine failure, and records a resolved account name only by its length —
  that file is committed to a public repository, and the Paystack harness leaked a real name into
  its equivalent on the first run.

- **Monnify adapter** in both languages, with 76 tests each over 18 fixtures. Monnify is the first
  provider that does not take a static key: it exchanges an HTTP Basic pair for a Bearer token at
  `POST /api/v1/auth/login`, and the adapter caches that token, refreshes it a minute before it
  expires using the lifetime Monnify returns rather than a constant, shares one login between
  concurrent callers so a cold client firing ten requests performs one login rather than ten, and
  retries a 401 only on a request that is safe to repeat. It covers checkouts with sub-account
  splits, verification by either reference, the transaction search page, refunds, reserved
  (static) virtual accounts including the `allBanks` flag that issues a NUBAN at every partner
  bank at once, BVN and KYC updates, per-account income splits, sub-accounts, single and bulk
  payouts with their OTP gate, bank lists, account resolution, wallet balance and webhooks.

- **Fincra adapter** in both languages, with 62 tests each over 8 fixtures. It covers checkouts,
  refunds, permanent and temporary virtual accounts, wallet balances per currency, same-currency
  and cross-currency payouts, bank lists, account resolution, BVN verification and webhooks.

- `skipAuthorize` / `skip_authorize` on a request in both HTTP clients. A token-exchanging provider
  needs it: the login call carries its own credential header, and without this it asks the
  `authorize` callback for a token, which logs in, for ever. That is not a hypothetical — it was a
  heap exhaustion in the first run of the Monnify suite.

- `majorToString` / `major_to_string` in `core/money`, for a provider that types an amount field as
  a string. Fincra's temporary-virtual-account endpoint is the first: `str(350.0)` in Python is
  `"350.0"` while `String(350)` in JavaScript is `"350"`, and a parity case now pins which one
  Fincra gets.

- Cross-language parity coverage for both new adapters — 9 Monnify shapes and 7 Fincra shapes over
  their fixtures, plus statuses, channels, date formats and amounts, taking the harness to **353
  cases across 38 groups**. It includes the webhook hash Monnify publishes, recomputed in both
  languages, so neither can drift back towards the (wrong) prose on Monnify's documentation page.

- Sandbox harnesses for Monnify (`npm run sandbox:monnify`) and Fincra (`npm run sandbox:fincra`).
  The Monnify one runs for anyone: Monnify publishes working public test credentials in its own API
  reference, so it needs no account — though the credentials still come from `.env` rather than
  from the repository. Seventeen of its nineteen probes pass against the live sandbox.

### Fixed

- **Flutterwave rejected every checkout created without a `callbackUrl`.** Its `/v3/payments`
  endpoint requires `redirect_url` and documents it as optional; without it the call fails
  `400 One or more required parameters missing`, an error naming no field, on the one endpoint
  every integration starts with. No fixture could have caught this, because the fixtures are
  Flutterwave's own samples and its samples all include the field — only a live run did. Both
  packages now refuse the call locally with a message naming the field, and a test in each pins it.

- A money-rounding tolerance in the Python package loose enough to **accept a discrepancy of almost
  two naira**. `from_major` allowed `1e-9 * max(1, |amount|)`, so on a balance of
  `1999792413.990817` it returned a `Money` the provider had never reported, where TypeScript
  correctly returned nothing. It is now one relative float ulp, the same test TypeScript makes with
  `Number.EPSILON`. Found by the first cross-language Fincra parity run, which is exactly the class
  of defect that harness exists to catch.

- **Monnify's transaction search is enveloped, and its rows have a different shape than its
  specification shows.** The spec puts the page at the top level outside `responseBody` and shows
  flat customer fields; the sandbox returns the ordinary envelope, nests the customer under
  `customerDTO`, and dates each row with the zoneless `createdOn`. The fixture was re-recorded from
  the sandbox, with the envelope-less fallback kept as a defence since the document still says
  otherwise.

- **Monnify does have a verify-by-your-own-reference route.** The adapter had declared
  `GET /api/v2/merchant/transactions/query` absent and fell back to searching, which would have
  made every verification a page scan. Rewritten in both languages and confirmed against the
  sandbox, where an unseen reference answers with a `NotFoundError` naming it.

- Four Flutterwave endpoint paths, caught by reading each reference page rather than the
  documentation index that the first pass had worked from. Listing refunds is `GET /refunds`, not
  `/transactions/refunds`; a BVN update is `PUT /virtual-account-numbers/{order_ref}` with the BVN
  alone in the body, with no `/update-bvn` route; deactivating a virtual account is a **POST** to
  that same path with a `status` of `inactive` or `active`, one route serving both directions; and a
  wallet statement puts the reference in the path, with `from` and `to` **required** rather than
  optional. Each would have been a 404 at runtime, inside a payout or a KYC update. All four are now
  pinned by tests in both languages. Two improvements fell out of the same pass: a
  `reactivateVirtualAccount` method, and required date arguments on a wallet statement so a missing
  range fails locally with a message naming the fields.

- `toMajor` would emit `0.01` XOF — an amount its own inverse refuses, and one a provider would
  silently drop the fraction of, since XOF has no subunit. `fromMajor` had always refused it. The
  two directions were tested separately and each passed; only the cross-language parity cases,
  comparing both directions at once, exposed the asymmetry. Fixed in both languages with identical
  messages and regression-tested.

### Changed

- Three documentation claims corrected against what Monnify's sandbox actually does, each recorded
  in the code beside the behaviour it describes: `restrictPaymentSource` returns `false` when
  omitted rather than defaulting to `true` as documented, so the adapter always sends the field
  explicitly and neither default can surprise a caller; the access token lasted **828 seconds**,
  not the hour the documentation implies, which is why the adapter reads the lifetime from the
  response; and `/api/v1/disbursements/account/validate` is switched off rather than merely
  deprecated, answering `HTTP 422` with a migration message.

- **Bank codes are no longer normalised onto a single CBN/NIBSS code.** Measuring the real data
  showed naija-data carries a NIP code for only 49 of 898 institutions, while Paystack alone
  returns 292 Nigerian banks under codes of its own in three different lengths. The provider's own
  bank code is now authoritative and is never substituted; naija-data supplies institution
  identity, merger status and verification flags as enrichment. See the bank-codes section of
  DESIGN.md.
