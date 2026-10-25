# Providers

Everything in this file was read from each provider's **current official documentation** on the
date in the "Verified" row. Nothing here is from memory. Where a provider's docs are unclear,
contradictory or unreachable, that is written down as a finding rather than guessed at.

**naija-pay is not affiliated with, endorsed by, or sponsored by any provider listed here.**
All product and company names are the trademarks of their respective owners.

## How to read the status values

| Status | Meaning |
| --- | --- |
| **Docs verified** | Core facts below were read from the provider's own current docs on the date shown. |
| **Surveyed** | Documentation portal located and reachable, but detail not yet extracted end-to-end. |
| **Docs blocked** | Portal is private, down, or unreachable at time of checking. Build from fixtures, mark unverified. |
| **Sandbox verified** | Additionally exercised against the provider's sandbox with real test keys. |

No provider is **Sandbox verified** yet — that starts in milestone 4. Any adapter that is not
sandbox verified ships with a `notYetSandboxVerified` flag and a visible note in the docs site.

---

## Tier 1 — targeted for v1.0

### Paystack

| | |
| --- | --- |
| Docs | <https://paystack.com/docs/api/> |
| Verified | 2026-10-25 — **Docs verified** |
| API version | Unversioned REST (no version in path or header) |
| Base URL | `https://api.paystack.co` — **same host for test and live**; the key decides the environment |
| Auth | `Authorization: Bearer sk_test_... / sk_live_...` |
| Amounts | Currency subunit, integer. NGN minimum 50 naira. NGN, USD, GHS, ZAR, KES, XOF. XOF has no subunit but is still multiplied by 100, and a fractional part is silently dropped |
| Envelope | `{ status: boolean, message: string, data: object or array, meta?: object }` |
| Pagination | Both offset (`page`/`perPage`) and cursor, depending on the endpoint |
| Webhook signing | `x-paystack-signature` = **HMAC-SHA512, hex**, over the **raw request body**, keyed with the secret key |
| Webhook IP allowlist | `52.31.139.75`, `52.49.173.169`, `52.214.14.220` — same list for test and live |
| Webhook retries | Live: every 3 min for 4 tries, then hourly for 72 h. Test: hourly for 10 h, 30 s timeout per attempt |
| Rate limits | Not published as numbers; per-endpoint guidance only |
| Sandbox | **Self-serve.** Create a free account, test keys immediately |

Verified endpoints relevant to naija-pay:

- **Dedicated Virtual Accounts:** `POST /dedicated_account`, `POST /dedicated_account/assign`,
  `GET /dedicated_account`, plus a providers/banks endpoint. `assign` accepts `bvn`, `bank_code`,
  `account_number`, `country` (`NG` or `GH`), and the account can be attached to a `subaccount` or
  a `split_code`.
- **Transaction splits:** `POST /split` with `type: percentage | flat`,
  `subaccounts: [{ subaccount, share }]`, and
  `bearer_type: subaccount | account | all-proportional | all`. Returns a `split_code` (`SPL_...`).
- **Subaccounts:** `POST /subaccount` with `bank_code`, `account_number`, `percentage_charge`.
  Returns `subaccount_code` (`ACCT_...`), `settlement_schedule`, `is_verified`.

Documented events include `charge.success`, `transfer.success`, `transfer.failed`,
`transfer.reversed`, `refund.processed` / `.pending` / `.failed` / `.processing`, `subscription.*`,
`invoice.*`, `paymentrequest.*`, `charge.dispute.*`, `customeridentification.success` / `.failed`,
and DVA assignment success/failure events. A Webhook Events API can list, filter and resend events.

**Findings to encapsulate**

1. The signature is over the **raw bytes**. Any framework that re-serialises the JSON before you hash
   it will produce mismatches. Our handlers always capture the raw body.
2. The Create Subaccount reference lists `bank_code` as the field name, but the cURL sample on the
   same page sends `settlement_bank`. We will confirm which the API actually accepts in milestone 4,
   and accept both on our side.
3. One host for both environments means a live key in a staging deploy moves real money with no URL
   change to catch it. This is the main argument for our loud live-key warning.

### Flutterwave

Flutterwave currently runs **two live API generations at once**, and this materially affects the design.

| | v3 | v4 |
| --- | --- | --- |
| Docs | <https://developer.flutterwave.com/docs> (pages tagged `/v3.0.0/`) | <https://developer.flutterwave.com/v4.0.0/llms.txt> |
| Verified | 2026-10-25 — **Docs verified** (pages stamped `updatedAt` 2026-10-19) | 2026-10-25 — **Docs verified** (same stamp) |
| Base URL | `https://api.flutterwave.com/v3` | Test `https://developersandbox-api.flutterwave.com`, live `https://f4bexperience.flutterwave.com` |
| Auth | `Authorization: Bearer FLWSECK_TEST-... / FLWSECK-...` | **OAuth 2.0 client credentials** at `https://idp.flutterwave.com/realms/flutterwave/protocol/openid-connect/token`; access token lives **600 s** |
| Idempotency | Not documented | `X-Idempotency-Key` on every POST; replays return the original response plus `X-Idempotency-Cache-Hit: true` |
| Webhook signing | `verif-hash` header holds **your secret hash verbatim** | `flutterwave-signature` = **HMAC-SHA256, base64**, over the raw body, keyed with the secret hash |
| Test data | — | Archived and unrecoverable after **30 days** |

**The decisive finding:** the v4 documentation index covers card, mobile money, pay-with-bank-transfer,
pay-with-bank (NG), USSD, OPay, payouts, settlements, refunds and chargebacks — but it does **not**
cover virtual accounts, split payments, payout subaccounts, or direct debit. Those four exist only in
v3. Since naija-pay is built around exactly those features, the Flutterwave adapter has to straddle
both generations: v4 where available, v3 for virtual accounts, splits, payout subaccounts and
mandates. This is handled inside the adapter and never leaks into the normalised API.

**Findings to encapsulate**

1. **v3 webhook "verification" is not a signature.** The documented method is to compare the
   `verif-hash` header against your own secret hash. It proves only that the sender knows a shared
   secret; it does not bind the payload, so it gives no integrity and no replay protection. Any
   intermediary that has ever seen one webhook can forge every later one. naija-pay will accept v3
   webhooks but mark the resulting event `signatureStrength: "shared-secret"` and require the
   mandatory re-verify-before-giving-value step. This difference between providers is a large part of
   why a normalised webhook layer is worth having at all.
2. v4's own webhook page contradicts itself: the "Verifying Webhook Signatures" section correctly
   computes `HMAC-SHA256(raw body)` in base64, while the "Responding to Webhook Requests" sample a
   few paragraphs below still does the v3-style `signature !== secretHash` comparison. We implement
   the HMAC form and will confirm against sandbox.
3. A 600-second token means the adapter needs token caching with pre-emptive refresh, not a fetch per
   call. We refresh at 60 s remaining, exactly as their guide recommends.

### Monnify (Moniepoint)

| | |
| --- | --- |
| Docs | <https://developers.monnify.com/api> — machine-readable **OpenAPI 3.1** at <https://developers.monnify.com/collection/monnify-collection.yml> |
| Verified | 2026-10-25 — **Docs verified** (spec `info.version: 2.0.0`) |
| Base URL | Sandbox `https://sandbox.monnify.com`, live `https://api.monnify.com` |
| Auth | HTTP **Basic** (`base64(apiKey:secretKey)`) to `POST /api/v1/auth/login`, which returns a Bearer token with `expiresIn`; all other calls use that Bearer token |
| Sandbox | **Self-serve, and better than that:** Monnify publishes working public test credentials (test API key, secret and contract code) in its own docs, so our smoke tests can run with no signup at all |
| Webhook signing | **Not documented anywhere in the OpenAPI spec** — see findings |

Verified endpoint groups, read from the spec:

- **Reserved (static) accounts:** `POST /api/v2/bank-transfer/reserved-accounts`,
  `GET`/`DELETE /api/v2/bank-transfer/reserved-accounts/{accountReference}`, plus v1 operations for
  `update-customer-bvn`, `{ref}/kyc-info`, `add-linked-accounts`, `limit`, `transactions`,
  `update-income-split-config` and `update-payment-source-filter`. The `getAllAvailableBanks` flag
  reserves an account at **every** partner bank at once and returns the list.
- **Transactions:** `POST /api/v1/merchant/transactions/init-transaction`,
  `/api/v1/merchant/bank-transfer/init-payment`, card charge and card-token charge, 3-D Secure
  authorise, `/api/v1/transactions/search`, paycodes.
- **Disbursements:** `/api/v1/disbursements/wallet` (plus `balance`, `transactions`),
  `/api/v2/disbursements/batch` with OTP validation, `/api/v2/disbursements/account/validate`.
- **Sub-accounts:** `/api/v1/sub-accounts`, `/api/v1/sub-accounts/{subAccountCode}`.
- **Direct debit mandates:** `create`, `debit`, `debit-status`, `cancel-mandate/{mandateCode}`,
  `mandates`.
- **Refunds, settlements, invoices, limit profiles**, and VAS including `bvn-account-match`,
  `bvn-details-match`, `nin-details` and bills payment.

**Findings to encapsulate**

1. **Two features are gated behind commercial approval**, stated in the spec itself: the Transfer
   (disbursement) API requires meeting regulatory requirements and contacting sales, and live use of
   Sub Accounts requires relationship-manager approval. Our capability matrix marks these
   `requiresApproval` so nobody designs around a feature they cannot switch on.
2. **The OpenAPI spec documents no webhooks at all.** Monnify's webhook payloads and signature scheme
   live outside the spec (partly on a third-party Atlassian wiki that turned up in search and that we
   do not treat as authoritative). The signature scheme is therefore **unverified** and will be
   established against the sandbox in milestone 5 before the adapter claims webhook support.
3. Reserved accounts carry a per-account **income split config** — an inflow-level split that is
   conceptually different from Paystack's transaction splits. Our model keeps the two distinct.

### Fincra

| | |
| --- | --- |
| Docs | <https://docs.fincra.com/docs> — index at <https://docs.fincra.com/llms.txt> |
| Verified | 2026-10-25 — **Docs verified** (environment and auth pages stamped 2025-11-13; NGN virtual account page 2026-10-06) |
| Base URL | Sandbox `https://sandboxapi.fincra.com`, live `https://api.fincra.com` |
| Auth | **`api-key: <secret key>` header — not a Bearer token.** Public key travels as `x-pub-key` |
| Keys | Three per environment: secret key, public key, and a **separate webhook secret key** |
| Webhook signing | `signature` header = **HMAC-SHA512, hex**, keyed with the **webhook secret key** (not the API secret), over the `{event, data}` object |
| Sandbox | Self-serve signup; environments fully isolated, with separate business IDs and keys |

Features documented: checkout (redirect and standard, plus cross-currency); virtual accounts for NGN,
GHS, KES, TZS and FCY/corporate; direct debit and mandates; bank transfer; OPay; mobile money; a
direct charge API; same-currency and cross-currency payouts; PayShap; China CNAPS; Interac e-Transfer;
conversions; identity (bank account verification and BVN resolution); and per-domain webhooks
(pay-in, payout, mandate, charges, conversion, virtual account).

NGN permanent virtual accounts, verified from the docs:

- **BVN is required.** Requests are approved instantly, and inflows settle to the merchant balance.
- `accountType` is `individual` or `corporate`. Corporate additionally requires
  `KYCInformation.businessName` and `KYCInformation.bvnName`, which must match the name on the BVN.
- Supported `channel` values, with the enabled flag exactly as published: `globus` yes, `wema` yes,
  `habari` (GTB) yes, `sterling` yes, `moniepoint` yes, `uba` yes, `opay` yes, `bold` **no**,
  `providus` **no**. Defaults differ by account type — `wema` for corporate, `globus` called out for
  individual.

**Findings to encapsulate**

1. The documented HMAC input is `JSON.stringify(payload)` of the parsed `{event, data}` object, i.e.
   **a re-serialisation, not the raw bytes**. Their Python sample pins `separators=(',', ':')` and
   their JS sample relies on V8 key ordering. This is fragile across languages. naija-pay hashes the
   raw body first and falls back to a canonical compact re-serialisation only if that fails,
   reporting which path matched so we can raise the discrepancy upstream.
2. Auth is a bare `api-key` header. Our HTTP layer must not assume every provider uses `Bearer`.
3. Two of the nine published NGN virtual-account bank channels are disabled. Bank choice has to be a
   runtime capability query, not a hardcoded enum.

### Squad (GTCO)

| | |
| --- | --- |
| Docs | <https://docs.squadco.com/> |
| Verified | 2026-10-25 — **Docs verified**, with significant gaps (below) |
| Base URL | Sandbox `https://sandbox-api-d.squadco.com`, live `https://api-d.squadco.com` |
| Auth | `Authorization: Bearer` with the secret key; sandbox keys are prefixed `sandbox_sk_` |
| Checkout | `POST /transaction/initiate` returns a checkout URL |
| Webhook signing | Header **`x-squad-encrypted-body`** — algorithm and key **not documented** |
| Webhook sender IP | `18.133.63.109` |
| Sandbox | Self-serve; a separate Sandbox account is created explicitly |

Features documented: payment gateway modal over card, transfer, USSD and bank; virtual accounts
(static, and a dynamic v2 variant); payment links; transfers to any Nigerian beneficiary; recurring
payments by card and by bank direct debit; refunds.

Webhook payloads use **PascalCase** top-level keys, unlike every other provider here:
`{ "Event": "charge_successful", "TransactionRef": "...", "Body": { ... } }`.

**Findings to encapsulate**

1. **The signature algorithm is genuinely undocumented.** The docs say to encrypt the body of data
   and compare it against `x-squad-encrypted-body`, and name neither the hash nor the key. We will
   not guess. The Squad adapter ships with webhook verification marked **unverified** until it is
   established against the sandbox in milestone 6, and until then the handler refuses to mark events
   verified rather than silently trusting them.
2. **Documentation quality is the weakest of Tier 1.** The webhook reference page shows its endpoint
   as `POST https://api.gitbook.com/v1/users` — leftover GitBook boilerplate. Search also surfaced
   `sandbox-api-squadco.com` and `sandbox-api.squadco.com` in their own examples, both missing the
   `-d`; the rest of the docs use `sandbox-api-d.squadco.com`. We treat the `-d` hosts as correct and
   will confirm against the dashboard.
3. Their docs warn, correctly, to keep a transaction-reference check so as not to give double value.
   That is exactly what our idempotency helper does by default.

### Korapay (Kora)

| | |
| --- | --- |
| Docs | Current: <https://developers.korapay.com/> (index at `/llms.txt`). Older Postman reference still live at <https://docs.korapay.com/> |
| Verified | 2026-10-25 — **Docs verified** |
| Base URL | `https://api.korapay.com/merchant` for most paths (`/merchant/api/v1/...`); newer identity, pool-account and account-holder paths sit at `/api/v1/...` |
| Auth | `Authorization: Bearer sk_...` for pay-ins, payouts, virtual accounts, balances and verification; `Bearer pk_...` for the miscellaneous group only |
| Webhook signing | `x-korapay-signature` = **HMAC-SHA256, hex**, keyed with the secret key, over **`JSON.stringify(body.data)` — the `data` object only** |
| Sandbox | Self-serve, and the strongest sandbox tooling in Tier 1 — see below |

Features verified from the live collection: checkout standard and redirect; card charge (including a
flexible variant) with authorize and resend-OTP steps; bank transfer; pay-with-bank Instant EFT (ZAR);
mobile money with STK; vouchers; **virtual bank accounts** in NGN, USD, KES and GHS with
`account-holders`, `update-kyc` and a document-upload URL flow; **pool accounts**; **direct debit**
with both fixed and variable authorizations; refunds; single and bulk payouts; balances and balance
history; bank and mobile-money account resolution; identity verification for NG (BVN, NIN, vNIN,
passport, PVC, phone, CAC), GH and KE; card issuing with cardholders; stablecoin wallets.
Split payments are supported on the Initialize Charge endpoint. There is a dedicated guide for
handling underpayments and overpayments on bank transfers.

**Sandbox simulation endpoints** — unusually good, and we will build our integration tests on them:
`POST /virtual-bank-account/sandbox/credit`, `POST /pool-accounts/sandbox/credit`,
`POST /charges/mobile-money/sandbox/authorize-stk`, and `cards/simulate/auth|reversal|refunds`.

**Findings to encapsulate**

1. **The signature covers only the `data` object, so the `event` field is unauthenticated.** An
   attacker who replays a captured body cannot alter `data`, but the event name sits outside the
   signed region. naija-pay therefore derives the event type from signed `data` fields wherever it
   can, and always re-verifies with the API before giving value. We will report this upstream.
2. Signing a re-serialisation again: their PHP sample has to set `serialize_precision = -1` so that
   `json_encode` does not mangle the amount. A float round-trip inside signature verification is a
   good illustration of why naija-pay never represents money as a float.
3. Base paths are inconsistent between `/merchant/api/v1` and `/api/v1`, and the published Postman
   collection contains malformed URLs (for example `https://api.korapay.comapi/v1/...`, missing the
   slash). The adapter pins each endpoint explicitly rather than composing paths from one prefix.

---

## Tier 2 — after v1.0: more gateways and payment options

| Provider | Docs | Status (2026-10-25) | What we know now |
| --- | --- | --- | --- |
| **Interswitch** | <https://developer.interswitchgroup.com> — also `developer.interswitch.com`, `docs.interswitchgroup.com`, `sandbox.interswitchng.com/docbase` | **Surveyed** | OAuth 2.0 client credentials via Passport; creating a project in the developer console yields sandbox keys self-serve. **The sandbox token host is inconsistent between their own products** (`sandbox.interswitchng.com/passport/oauth/token` vs `passport-sandbox.interswitchng.com/passport/oauth/token`), and some APIs require `scope=profile`. Documentation is spread across four hosts and the marketplace portal is a JavaScript app that cannot be read without a browser. Highest integration cost in Tier 2. |
| **Nomba** | <https://developer.nomba.com> (index at `/llms.txt`) | **Surveyed** | Base `https://api.nomba.com` / `https://sandbox.nomba.com`. Token via `POST /v1/auth/token/issue` with `client_credentials` plus a required **`accountId` header**. Test keys need an account with KYC complete. Checkout, virtual accounts, transfers, and documented sandbox testing with test cards and webhooks. Cleanest Tier 2 docs. |
| **Paga** | <https://developer-docs.paga.com> (index at `/llms.txt`) | **Surveyed** | Two APIs, Collect and Business. Has dynamic ("Dynamic Payment Identifier") and persistent payment identifiers, direct debit, and **Subsidiary Accounts** — managed customer wallets, which makes Paga relevant to our wallet sub-account model as well as to collections. Auth scheme (hashed credentials) still to extract. |
| **Budpay** | <https://developer.budpay.com> | **Surveyed** | Portal reachable; detail not yet extracted. |
| **PalmPay** | <https://docs.palmpay.com> | **Surveyed** | Portal reachable; detail not yet extracted. |
| **Remita** | <https://api.remita.net> | **Surveyed** | Portal reachable. Of interest for RRR payments and direct-debit mandates, which matter to lenders. |
| **Payaza** | `docs.payaza.africa` | **Docs blocked** | Host did not resolve from here on 2026-10-25. Their getting-started guide indicates dashboard-issued test keys, with test requests allowed while KYB is still in progress. Retry before building. |
| **Credo (eTranzact)** | <https://docs.credocentral.com> | **Surveyed** | Host reachable but returned almost no content; needs a browser read. |
| **SeerBit** | `doc.seerbit.com`, `seerbit.readme.io` | **Docs blocked** | `doc.seerbit.com` did not resolve; the ReadMe mirror returns **401 (private)**. Cannot be built accurately until the docs are accessible — recommend requesting access. |
| **OPay** | `documentation.opaycheckout.com` | **Docs blocked** | Returned **HTTP 502** on 2026-10-25. Note that OPay wallet payments are already reachable *through* Flutterwave, Fincra and Korapay, so a direct OPay adapter is lower priority than it first looks. |
| **Xpress Payments** | — | **Docs blocked** | No public developer portal found. Parked until one exists or you have an account. |

## Tier 3 — banking-as-a-service: real accounts, wallets, NUBAN sub-accounts

| Provider | Docs | Status (2026-10-25) | What we know now |
| --- | --- | --- | --- |
| **Anchor** | <https://docs.getanchor.co> (index at `/llms.txt`) | **Docs verified** | Base `https://api.sandbox.getanchor.co` / `https://api.getanchor.co`. Dashboard-issued API keys with **per-key permissions and expiry dates**. Sandbox is invite-request then self-serve, and includes a **Simulate Transfer** tool to fund test accounts. Covers individual and business customers with KYC/KYB, deposit accounts and account numbers, balances, **subledgers (sub-accounts)**, NIP transfers, **book transfers**, bulk transfers, reserved accounts, pay-with-transfer dynamic virtual accounts, card issuing, and bills (airtime, data, electricity, cable TV). Webhooks are created per URL with a secret token and selected event types. **The best-documented BaaS of the group and the right first Tier 3 adapter.** |
| **Safe Haven MFB** | <https://safehavenmfb.readme.io> | **Surveyed** | Auth is a **signed client assertion exchanged for an API token**, refreshed at the same endpoint — the most involved auth scheme we have seen, and a good test of our auth abstraction. Documents accounts and sub-accounts (individual and corporate), virtual accounts, transfers with bank list / name enquiry / status, and identity verification plus credit check. |
| **Lenco** | <https://lenco-api.readme.io> (note: `docs.lenco.co` is **not** the docs host) | **Surveyed** | Virtual accounts (create, look up, transactions), single and bulk bank transfers, webhooks, recipients, banks and account resolution, bill payments, POS. |
| **VFD Microfinance Bank (VBaaS)** | <https://vbaas-docs.vfdtech.ng> | **Docs blocked** | Host reachable and titled "Wallets API Documentation", but content is not readable without a browser session. Access very likely requires onboarding. |
| **Kuda (Kuda Business)** | <https://kudabank.gitbook.io> | **Docs blocked** | GitBook reachable; the `kuda-openapi.kuda.com` endpoint returned 404. Onboarding required. |
| **Providus Bank** | — | **Docs blocked** | No public developer portal found. Onboarding required. |
| **9PSB** | — | **Docs blocked** | No public developer portal found. Onboarding required. |
| **Wema Bank (ALAT for Business)** | — | **Docs blocked** | No public developer portal found. Onboarding required. |

**Honest summary of Tier 3:** only **Anchor** has documentation good enough to build a trustworthy
adapter from today, with **Safe Haven** and **Lenco** close behind. The bank-owned BaaS providers
(VFD, Providus, 9PSB, Wema, Kuda) are all gated behind business onboarding and publish nothing usable
publicly. This is the single biggest reason to keep Tier 3 out of v1.0.

---

## Capability matrix

Hand-written for this milestone from the verified docs above. **From milestone 6 onward this table is
generated from the adapters' own declared capabilities** (`npm run docs:matrix`), so it can never
drift from the code. Legend: yes = documented and planned for the adapter; **A** = documented but
requires the provider's commercial approval; ? = provider surveyed only, not yet confirmed;
no = not offered.

### Tier 1 (v1.0)

| Feature | Paystack | Flutterwave | Monnify | Fincra | Squad | Korapay |
| --- | :-: | :-: | :-: | :-: | :-: | :-: |
| Hosted checkout | yes | yes | yes | yes | yes | yes |
| Inline / redirect | yes | yes | yes | yes | yes | yes |
| Card channel | yes | yes | yes | yes | yes | yes |
| Bank transfer channel | yes | yes | yes | yes | yes | yes |
| USSD channel | yes | yes | no | no | yes | no |
| Pay with bank account | yes | yes | no | yes | yes | yes |
| NQR / QR | no | yes | no | no | no | no |
| Wallet (e.g. OPay) | no | yes | no | yes | no | no |
| Mobile money (non-NG) | yes | yes | no | yes | no | yes |
| Verify by reference | yes | yes | yes | yes | yes | yes |
| List transactions | yes | yes | yes | yes | yes | yes |
| Refunds (full) | yes | yes | yes | yes | yes | yes |
| Refunds (partial) | yes | yes | yes | yes | ? | yes |
| Static / reserved VA | yes | yes | yes | yes | yes | yes |
| Dynamic / temporary VA | yes | yes | yes | yes | yes | yes |
| Choose VA bank | yes | no | yes (all banks at once) | yes (7 of 9 enabled) | ? | yes |
| VA KYC update | yes | ? | yes | yes | ? | yes |
| VA inflow listing | yes | yes | yes | yes | ? | yes |
| Over/underpayment guidance | no | no | no | no | no | **yes, documented** |
| Split-payment subaccounts | yes | yes (v3) | **A** | ? | ? | yes |
| Multi-party splits | yes | yes (v3) | yes (income split) | ? | ? | yes |
| Wallet / NUBAN subaccounts | no | yes (payout subaccount, v3) | **A** | ? | no | yes (pool + account-holders) |
| Book / internal transfer | no | yes (wallet-to-wallet) | ? | ? | no | ? |
| Payouts single | yes | yes | **A** | yes | yes | yes |
| Payouts bulk | yes | yes | **A** (batch + OTP) | yes | ? | yes |
| Account name resolution | yes | yes | yes | yes | yes | yes |
| Bank list | yes | yes | yes | yes | yes | yes |
| Balance | yes | yes | yes | yes | ? | yes |
| Transfer reversal events | yes | yes | ? | ? | ? | ? |
| Plans / subscriptions | yes | yes (v3) | yes (recurring) | no | yes | no |
| Charge saved card token | yes | yes | yes | yes | yes | yes |
| Direct debit / mandates | yes | yes (v3 e-mandate) | yes | yes | yes | yes (fixed + variable) |
| BVN / NIN verification | yes | yes (BVN) | yes (both) | yes (BVN) | ? | yes (BVN, NIN, vNIN, CAC) |
| Webhook signature usable | yes | v4 yes / v3 **no** | **unknown** | yes | **unknown** | partial |
| Sandbox self-serve | yes | yes | yes (+ public test keys) | yes | yes | yes |
| Sandbox inflow simulation | no | no | ? | ? | ? | **yes, dedicated endpoints** |

### Tier 3 front-runners (post-1.0)

| Feature | Anchor | Safe Haven | Lenco |
| --- | :-: | :-: | :-: |
| Customer onboarding + KYC/KYB | yes | yes | ? |
| Real deposit account (NUBAN) | yes | yes | ? |
| Sub-accounts / subledgers | yes | yes | ? |
| Static virtual account | yes (reserved) | yes | yes |
| Dynamic virtual account | yes (pay with transfer) | ? | ? |
| Balance + statement | yes | ? | yes |
| NIP bank transfer | yes | yes | yes |
| Book / internal transfer | yes | ? | ? |
| Bulk transfer | yes | ? | yes |
| Name enquiry | ? | yes | yes |
| Card issuing | yes | no | no |
| Bills / VTU | yes | no | yes |
| Webhooks with signature | yes (SHA-1) | ? | yes |
| Sandbox self-serve | yes (after invite) | ? | ? |

The `?` cells are the honest state of the survey, not an omission. Each one is closed either by
reading that provider's docs in the milestone that builds its adapter, or by a sandbox test.

## Webhook signing: the whole picture

This table is the clearest single argument for the project, so it goes in the README too.

| Provider | Header | Algorithm | Signed over | Keyed with | Integrity? |
| --- | --- | --- | --- | --- | --- |
| Paystack | `x-paystack-signature` | HMAC-SHA512, hex | raw body | secret key | Yes — full body |
| Flutterwave v4 | `flutterwave-signature` | HMAC-SHA256, base64 | raw body | secret hash | Yes — full body |
| Flutterwave v3 | `verif-hash` | none — literal comparison | nothing | secret hash | **No — none** |
| Monnify | undocumented | undocumented | — | — | Unknown |
| Fincra | `signature` | HMAC-SHA512, hex | re-serialised `{event, data}` | **webhook** secret key | Yes, with canonicalisation risk |
| Squad | `x-squad-encrypted-body` | **undocumented** | — | — | Unknown |
| Korapay | `x-korapay-signature` | HMAC-SHA256, hex | re-serialised **`data` only** | secret key | Partial — event name unsigned |
| Anchor | `x-anchor-signature` | HMAC-**SHA1**, base64 | body | webhook token | Weakest algorithm |

Seven providers, seven schemes, three hash algorithms, two encodings, two different key types, and
three cases where the documentation does not let you verify correctly at all. Every one of these is
hand-written separately inside every Nigerian startup today.

Two consequences for naija-pay's design:

1. Every verification is **constant-time**, and every parsed event carries
   `signatureStrength: "full-body" | "partial-body" | "shared-secret" | "unverified"` so an
   application can refuse to act on a weak one.
2. `reverifyBeforeGivingValue` is **on by default** for every provider, not an opt-in. With three
   providers unable to offer real integrity, re-checking the transaction over the API before
   crediting anyone is the only safe default.

## Anchor's signature, in detail

Worth recording because the docs contradict themselves. The prose states
`Base64(HMAC_SHA1(requestbody, key = webhook token))`, which reads as base64 of the raw digest. Both
code samples instead compute the **hex** digest and then base64-encode **that hex string**:

```js
Buffer.from(crypto.createHmac('sha1', token).update(body).digest('hex')).toString('base64')
```

These produce different values. We implement the sample form (base64-of-hex), accept the prose form as
a fallback, and will confirm which the live webhooks actually use against sandbox in Tier 3.

## Nigerian regulatory requirements affecting the SDK

Recorded as **observed API behaviour**. The underlying CBN citations are still **to be confirmed**
before any of this is published as guidance:

- **BVN is required for permanent/reserved virtual accounts.** Fincra states this outright for NGN
  permanent accounts. Paystack accepts `bvn` on DVA assignment and emits
  `customeridentification.success` / `.failed`. Monnify exposes `update-customer-bvn`, `kyc-info` and
  a `limit` endpoint per reserved account. Korapay has `account-holders` plus `update-kyc` and
  supporting-document upload. The shape of these APIs is consistent with a requirement to tie a
  reserved account to a verified identity.
- **KYC tiers drive transfer and balance limits.** Monnify's `limit-profile` resource and Anchor's
  customer KYC levels both expose this. Our model surfaces it as a typed `kycTier` and a
  `KycRequiredError` rather than letting a limit failure arrive as an opaque provider message.
- **NIN is accepted alongside BVN** by Monnify (`nin-details`) and Korapay (`ng/nin`, `ng/nin-phone`,
  `ng/vnin`).
- **NDPA 2023** makes BVN, NIN and account numbers personal data that must not be logged. Redaction
  is built into the HTTP and logging layer, not left to the application.

Before milestone 8 publishes any compliance guidance, every claim above gets a citation to the actual
CBN circular or NDPA section, verified on the date of writing. Until then this section is marked
**observed, not legally verified**, and the docs site will say so.

## Re-verification

The weekly GitHub Actions workflow (milestone 8) re-reads each provider's documentation index and
diffs the facts in this file — base URLs, auth method, signature scheme, documented endpoints — and
opens an issue when something moves. Several providers publish machine-readable indexes that make this
cheap and reliable:

| Provider | Machine-readable source |
| --- | --- |
| Monnify | OpenAPI 3.1 at `developers.monnify.com/collection/monnify-collection.yml` |
| Flutterwave | `developer.flutterwave.com/llms.txt` and `/v4/llms.txt`; every page has a `.md` form with an `updatedAt` stamp |
| Fincra | `docs.fincra.com/llms.txt`, same `.md` plus `updatedAt` convention |
| Korapay | `developers.korapay.com/llms.txt`; legacy Postman collection JSON |
| Anchor | `docs.getanchor.co/llms.txt`, plus a published changelog |
| Nomba, Paga | `/llms.txt` |
| Paystack, Squad | No machine-readable index. Paystack additionally blocks plain HTTP fetches (Cloudflare) and must be read with a real browser |
