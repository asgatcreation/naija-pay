# naija-pay — plan

Milestone 1 output, 2026-10-25. Three decisions need your answer before milestone 2 starts; they are
marked **DECISION** below.

## 1. Package names — one problem

| Registry | `naija-pay` | Verdict |
| --- | --- | --- |
| **npm** | **TAKEN** | `naija-pay@1.0.0`, "Simplified Paystack integration for React", published 2026-03-27 by `softcode96`. One version, no repository link. |
| **PyPI** | free | available |
| GitHub | free | `github.com/asgatcreation/naija-pay` does not exist yet |

Also checked and free: `naijapay` and `naija-pay-sdk` on both registries, and the npm scope
`@asgatcreation/naija-pay`.

We cannot use the unscoped npm name, and asking someone to hand over a package is not worth it.

**DECISION 1 — my recommendation:** keep the project, repo and PyPI name `naija-pay`, and publish on
npm as **`@asgatcreation/naija-pay`**.

Why this one: a scope is normal and trusted on npm (it is how most multi-package projects publish),
it ties the package to your GitHub identity, nobody can squat variations of it, and the import path
stays readable — `import { NaijaPay } from "@asgatcreation/naija-pay"`. The alternative,
`naijapay` unscoped on both registries, gives a shorter npm install but splits the brand from the repo
name and loses the `naija-data` family resemblance. The third option, renaming everything to
`naijapay`, is cleanest in theory but the hyphenated form reads better and matches `naija-data`.

I have **not** reserved anything. Registering a name is irreversible, so that is yours to do when you
have decided.

## 2. Provider tiers — recommended final list

Research changed my view on three of them. Changes from your original list are called out.

### Tier 1 — v1.0, six adapters

**Paystack, Flutterwave, Monnify, Fincra, Squad, Korapay** — unchanged from your list. All six have
self-serve sandboxes and documentation good enough to build from, and they are genuinely the ones
Nigerian startups reach for first.

Two warnings, both from PROVIDERS.md:

- **Flutterwave is roughly double the work of the others.** It is two API generations at once: v4
  (OAuth 2.0, proper HMAC webhooks, idempotency keys) has no virtual accounts, splits, payout
  subaccounts or direct debit, so those must come from v3 (bearer key, no real webhook integrity).
  The adapter straddles both. I would still keep it in Tier 1 — it is too widely used to leave out —
  but it should get its own milestone rather than share one.
- **Squad and Monnify have undocumented webhook signature schemes.** Both ship with webhook
  verification marked unverified until we establish the scheme against their sandboxes. If that
  cannot be done, those two adapters ship with collections and payouts but webhook support flagged
  clearly as unverified. I will not guess at a signature algorithm in a payments SDK.

### Tier 2 — after v1.0

**Promote to the front of Tier 2:** **Nomba** and **Paga**. Nomba has the cleanest Tier 2 docs of the
whole set, and Paga's Subsidiary Accounts make it useful for wallets as well as collections.

**Then:** Interswitch, Remita, Budpay, PalmPay, Credo.

**Demote:** **OPay**. Its docs site returned HTTP 502, and — more to the point — OPay wallet payments
are already reachable *through* Flutterwave, Fincra and Korapay, which are Tier 1. A direct OPay
adapter adds much less than its position on the original list suggests.

**Blocked until access improves:** **SeerBit** (docs private, 401) and **Payaza** (docs host did not
resolve). Both are worth asking for access to; neither can be built accurately today.

**Park:** **Xpress Payments** — no public developer portal found at all.

### Tier 3 — BaaS, after Tier 2 (or sooner, if a wallet product needs it)

**Build:** **Anchor** first — it is the best-documented BaaS in Nigeria by a clear margin, with a
self-serve sandbox and a transfer simulator. Then **Safe Haven MFB** (its signed-client-assertion
auth is also a good stress test of our auth abstraction), then **Lenco**.

**Onboarding-gated, build on request:** VFD (VBaaS), Kuda, Providus, 9PSB, Wema ALAT. None of these
publishes usable public documentation. Building them from guesswork would be the opposite of what
this project is for; each gets built when you have an account and we can read the real docs.

**DECISION 2:** confirm these tiers, the Flutterwave split into its own milestone, and the OPay
demotion.

## 3. Repository layout

A single repository, npm workspaces for the TypeScript side, with shared fixtures at the root so both
languages test against the same recorded data.

```
naija-pay/
├── README.md  LICENSE  CONTRIBUTING.md  CODE_OF_CONDUCT.md  SECURITY.md  CHANGELOG.md
├── PROVIDERS.md            provider facts, capability matrix, verification dates
├── DESIGN.md               the normalised API contract
├── PLAN.md                 this file
├── .env.example            empty placeholders only
├── fixtures/               THE SHARED SOURCE OF TRUTH FOR BOTH LANGUAGES
│   ├── providers/<provider>/<operation>/{request,response,normalised}.json
│   ├── webhooks/<provider>/<event>/{headers,body.raw,normalised}.json
│   └── pricing/<provider>.json        fees, with verifiedOn and source URL
├── data/
│   └── banks.generated.json           built from naija-data, committed, no runtime dep
├── packages/
│   ├── ts/
│   │   ├── src/
│   │   │   ├── core/        money, errors, http, retry, idempotency, redaction, capabilities
│   │   │   ├── webhooks/    parse, verify, idempotency store, framework handlers
│   │   │   ├── router/      strategies, circuit breaker
│   │   │   ├── providers/   paystack/ flutterwave/ monnify/ fincra/ squad/ korapay/ mock/
│   │   │   └── cli/
│   │   └── package.json     ESM + CJS, per-provider exports, zero runtime deps
│   └── python/
│       ├── src/naija_pay/   core/ webhooks/ router/ providers/ cli/  (sync + async)
│       └── pyproject.toml   httpx only; extras: django, fastapi, flask, drf
├── examples/
│   ├── nextjs-marketplace/  vendor split sub-accounts
│   └── django-wallet/       virtual accounts, wallet sub-accounts, transfers
├── docs/                    Astro Starlight
└── .github/workflows/       ci, parity, sandbox-weekly, bundle-size, release
```

Each provider directory in both languages holds the same files, so "add a provider" is a checklist:
`client`, `collections`, `virtual-accounts`, `split-accounts`, `wallets`, `payouts`, `recurring`,
`webhooks`, `capabilities`, `errors.map`. CONTRIBUTING.md will carry that checklist and a template.

**Docs site:** Astro Starlight on GitHub Pages. It is the best fit for a docs site with generated
reference pages, it builds fast in CI, and GitHub Pages keeps everything inside the one account you
already have — no extra service to sign up for.

## 4. Tooling versions

Confirmed on your machine today: **Node 24.16.0**, **Python 3.13.5**, **git 2.55.0**. All current
stable. Proposed: TypeScript 5.x, Vitest, tsup, Biome (lint + format, one tool, no config sprawl);
Python with uv, pytest, mypy strict, ruff. Nothing gets installed until you say so, and I will list
exactly what each command installs first.

## 5. Milestones

Milestone 1 is this document set. Each later milestone ends with tests passing, a commit, and a short
report of what I actually ran.

| # | Milestone | What you need to do |
| --- | --- | --- |
| 1 | **Research, PROVIDERS.md, capability matrix, API design, plan** — **done** 2026-10-25 | — |
| 2 | **Scaffold repo, MIT licence, CI, contributing files** — **done** 2026-10-26, 9 CI jobs green | — |
| 3 | **Core: money, errors, HTTP with retries and idempotency, redaction, capabilities, signature schemes, bank matching from naija-data, normalised events and inflow rules, mock provider, parity harness** — **done** 2026-10-30 | — |
| 4 | **Paystack** adapter, both languages, all features, webhooks, tests; then sandbox-verified | Create a free Paystack account, paste the **test** secret key into `.env` and into GitHub Actions secrets. I will tell you exactly where to click |
| 5 | **Flutterwave** adapter (v4 + v3, its own milestone) | Flutterwave test account: v3 keys and v4 client ID/secret |
| 6 | **Monnify** and **Fincra** adapters | Monnify needs nothing at first — they publish public test credentials. Fincra: a sandbox account |
| 7 | **Squad** and **Korapay** adapters; webhook schemes for Squad and Monnify established against sandbox; capability matrix generated from code | Squad sandbox account, Korapay test account |
| 8 | Router and failover, fee calculator, reconciliation, CLI, framework webhook handlers, direct debit | — |
| 9 | Docs site and both example apps deployed; weekly sandbox drift workflow | Approve GitHub Pages being switched on |
| 10 | Release automation; publish `0.1.0` pre-release **with your explicit approval**, test installs from the real registries, then `1.0.0` with your approval; README polish; launch posts for X, LinkedIn and dev.to | Create npm and PyPI accounts, enable PyPI trusted publishing, approve each publish |
| 11 | After 1.0, when you say go: Tier 2 gateways, Tier 3 BaaS wallet accounts, bills/VTU, Go client — one provider at a time | — |

**DECISION 3:** approve the milestone order, in particular Flutterwave getting its own milestone
(which makes it 11 milestones rather than 10).

## 6. What I will not do without asking you

- Register any name on npm or PyPI, or publish any version.
- Create any account anywhere.
- Commit or print a secret, or read your `.env` back to you.
- Delete anything substantial.
- Kill a process I did not start — your dev servers on ports 8000 and 3000 are left alone.

## 6a. Carried forward out of milestone 3

- **The Python async client is not written yet.** The retry, backoff and error-mapping helpers are
  shared and ready for it, but it lands alongside the first real adapter in milestone 4 rather than
  shipping untested async code now.
- **The dev toolchain is still not installed.** Everything so far runs on Node's built-in test
  runner and Python's `unittest`, with zero installs, which is why CI is genuinely green rather
  than aspirational. Biome, tsup, TypeScript, mypy, ruff and pytest arrive in milestone 4, and I
  will show you the exact install list first. A `tsc --noEmit` typecheck job and a build job that
  runs the compiled output on Node 20 arrive with them.
- **Bank coverage is 61.4%** against Paystack's live list (180 of 293). Two fixable gaps are
  upstream in naija-data: `ALAT by WEMA` needs an alias on Wema Bank, and NIP code coverage is 49
  of 898. Worth a data-correction issue on naija-data, which would lift coverage for every adapter.

## 7. Open questions for later milestones, recorded so they are not forgotten

1. **Squad and Monnify webhook signatures** — establish against sandbox in milestones 6 and 7, or
   ship those adapters with webhook support flagged unverified.
2. **CBN and NDPA citations** — every regulatory claim in the docs needs a citation to the actual
   circular, verified on the day of writing. Currently marked "observed, not legally verified".
3. **Paystack `bank_code` vs `settlement_bank`** — their own reference and sample disagree; confirm
   in milestone 4.
4. **Anchor's signature encoding** — prose and code samples disagree; confirm against sandbox.
5. **SeerBit and Payaza docs access** — worth requesting; both are currently unreadable.
6. **Fee tables** — need a published-pricing source URL and a verification date per provider before
   the fee calculator ships.
