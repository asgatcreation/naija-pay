# naija-pay — normalised API design

Draft for milestone 1. This is the contract: once v1.0 ships, breaking it needs a major version.
Everything here follows from the provider research in [PROVIDERS.md](PROVIDERS.md).

## Design rules

1. **One concept, one name, in both languages.** TypeScript uses `camelCase`, Python uses
   `snake_case`, and nothing else differs. `virtualAccount.create` / `virtual_account.create`.
2. **Money is an integer in the currency's minor unit. Always.** No floats anywhere, not even in
   test fixtures. Korapay's own PHP sample having to disable float precision mangling is the proof
   that this matters.
3. **Nothing is hidden.** Every normalised object carries `raw`, the provider's untouched response,
   and every client exposes an escape hatch for calling provider endpoints we have not wrapped.
   Developers should never have to abandon naija-pay to reach one unusual field.
4. **Unsupported is explicit, never silent.** If a provider cannot do something, the call raises
   `UnsupportedOperationError` at once. It never degrades quietly into something that looks like it
   worked.
5. **Safe by default.** Retries only on idempotent operations, re-verification before giving value,
   redaction on by default, live keys outside production produce a loud warning.
6. **No runtime dependencies in TypeScript, `httpx` only in Python.** Bank codes are generated from
   naija-data at build time and shipped as data, so there is no runtime dependency on it.

## Client construction

```ts
import { NaijaPay } from "naija-pay";
import { paystack } from "naija-pay/paystack";

const pay = new NaijaPay({
  providers: [paystack({ secretKey: process.env.PAYSTACK_SECRET_KEY })],
  environment: "test",            // "test" | "live" — checked against the key's own prefix
  timeout: 30_000,
  retries: { attempts: 3, baseDelayMs: 200, maxDelayMs: 4_000 },
  redact: true,
  onLog: (event) => logger.info(event),   // already redacted
});
```

```python
from naija_pay import NaijaPay
from naija_pay.providers import paystack

pay = NaijaPay(
    providers=[paystack(secret_key=os.environ["PAYSTACK_SECRET_KEY"])],
    environment="test",
    timeout=30.0,
)
# and the async twin, identical surface:
apay = AsyncNaijaPay(providers=[...])
```

Each provider is a **separate entry point** (`naija-pay/paystack`, `naija-pay/monnify`, ...) so a
bundler only includes what the app imports. The root package exports the types, errors, router,
webhook parser and money helpers — no provider code.

**Key/environment mismatch.** Every adapter declares how to recognise its own test keys
(`sk_test_`, `FLWSECK_TEST-`, `MK_TEST_`, `sandbox_sk_`, ...). Constructing a client with a live key
while `environment` is `"test"` throws. A live key with `environment: "live"` outside a recognised
production context (`NODE_ENV`/`ENV` not production) logs a single loud warning. Monnify and Fincra
tell test from live by host rather than key prefix, and Paystack uses the same host for both — so
this check is the only thing standing between a staging deploy and real money.

## Money

```ts
type Currency = "NGN" | "GHS" | "KES" | "ZAR" | "USD" | "XOF" | ...;

interface Money {
  readonly amount: number;   // integer, minor unit (kobo for NGN). Never a float.
  readonly currency: Currency;
}

const ngn = (kobo: number) => money(kobo, "NGN");
money(150_00, "NGN");           // 150 naira
naira(150);                     // helper: 15000 kobo
```

`money()` throws on a non-integer, on a negative amount where the operation forbids it, and on an
amount above `Number.MAX_SAFE_INTEGER`. Python uses an `int` and a frozen dataclass.

Split arithmetic is exact and rounds to the kobo with a documented rule: shares are computed with
integer maths, and the **remainder goes to the main account**, never silently lost. Property-based
tests assert that for any amount and any set of shares, the parts sum exactly to the whole.

`Currency` knows its own minor-unit exponent, including the XOF special case Paystack documents
(no subunit, but still multiplied by 100, with fractions dropped).

## Results and errors

Every call either returns the normalised object or raises a typed error. No `{ ok: false }` unions
to unwrap, in either language.

```
NaijaPayError
├── ConfigurationError          bad or missing keys, environment mismatch
├── AuthenticationError         401 / invalid key
├── ValidationError             provider rejected the request shape; .fields carries per-field detail
├── KycRequiredError            BVN/NIN needed, or KYC tier too low; .required lists what is missing
├── InsufficientFundsError
├── DuplicateReferenceError     reference already used
├── NotFoundError
├── RateLimitedError            .retryAfter when the provider gives it
├── ProviderDownError           5xx, or circuit breaker open
├── NetworkError                timeout, DNS, connection reset
├── UnsupportedOperationError   this provider cannot do this; .provider, .operation
├── WebhookVerificationError    signature did not verify
└── ProviderError               anything we could not classify
```

Every error carries `provider`, `operation`, `requestId`, `httpStatus`, and
`providerCode` / `providerMessage` — the provider's **original** code and message, untouched, so
support conversations with the provider still work. Errors are redacted before they are stringified:
a BVN, NIN or account number in a provider message is masked.

`retryable` is a property of the error, not a guess by the caller: `NetworkError`,
`RateLimitedError` and `ProviderDownError` are retryable; `ValidationError` and
`DuplicateReferenceError` are not.

## 1. Collections

```ts
const checkout = await pay.checkout.create({
  amount: naira(5_000),
  reference: "order_01HQ...",          // yours, must be unique
  customer: { email: "ada@example.com", name: "Ada Obi", phone: "+2348100000000" },
  channels: ["card", "bank_transfer", "ussd"],
  callbackUrl: "https://app.example.com/pay/return",
  metadata: { orderId: "1234" },
  split: { code: "SPL_..." },          // optional, see sub-accounts
});
// → { reference, providerReference, checkoutUrl, accessCode?, provider, raw }

const txn = await pay.transactions.verify("order_01HQ...");
// → Transaction
```

```ts
interface Transaction {
  reference: string;               // yours
  providerReference: string;
  status: TransactionStatus;
  amount: Money;                   // what you asked for
  amountPaid: Money;               // what actually arrived — may differ, see virtual accounts
  fees: Money | null;
  settledAmount: Money | null;
  channel: Channel | null;
  paidAt: Date | null;
  customer: Customer | null;
  authorization: CardAuthorization | null;   // token for later charges; never raw card data
  provider: string;
  raw: unknown;
}

type TransactionStatus =
  | "pending" | "successful" | "failed" | "abandoned" | "reversed";

type Channel =
  | "card" | "bank_transfer" | "ussd" | "bank_account" | "qr"
  | "wallet" | "mobile_money" | "apple_pay" | "google_pay";
```

Statuses are normalised from each provider's vocabulary; the provider's own string stays on
`raw`. Also: `pay.transactions.list({ from, to, status, cursor })` and
`pay.refunds.create({ transactionReference, amount? })` — partial refunds where supported, and
`UnsupportedOperationError` where not.

**Cards are never touched.** No endpoint in naija-pay accepts a PAN, CVV or expiry. Collections go
through hosted or inline checkout, and recurring charges use provider tokens. The docs will state
plainly what this means for the developer's PCI DSS scope (SAQ A rather than SAQ D), and that using
a provider's direct-card-charge endpoint — which some offer — takes them out of that scope and out
of naija-pay's support.

## 2. Virtual accounts

The two kinds are separate methods, because confusing them is a real production bug.

```ts
// STATIC / RESERVED — one per customer, lives forever, needs KYC
const va = await pay.virtualAccounts.createStatic({
  customer: { email, name, phone },
  kyc: { bvn: "22...", nin: "12..." },     // see KYC rules below
  preferredBank: "wema",                   // optional; capability-checked
  allBanks: false,                         // Monnify can return every partner bank at once
  reference: "cust_8891",
});

// DYNAMIC / TEMPORARY — one per transaction, expires
const va = await pay.virtualAccounts.createDynamic({
  amount: naira(12_500),
  reference: "order_01HQ...",
  expiresIn: 1_800,          // seconds
  singleUse: true,
});
```

```ts
interface VirtualAccount {
  reference: string;
  accounts: BankAccount[];   // plural: Monnify can reserve at several banks at once
  kind: "static" | "dynamic";
  status: "active" | "inactive" | "expired" | "closed";
  expiresAt: Date | null;
  amount: Money | null;      // dynamic accounts only
  customer: Customer | null;
  kycStatus: "pending" | "verified" | "failed" | "not_required";
  provider: string;
  raw: unknown;
}

interface BankAccount {
  accountNumber: string;     // masked in logs and errors
  accountName: string;
  bankName: string;
  bankCode: string;          // CBN/NIBSS code, mapped from naija-data
  bankSlug: string | null;   // the provider's own slug, kept for round-tripping
}
```

Also `get`, `list`, `updateKyc`, `deactivate`, and `listInflows(reference, { from, to })`.

**KYC.** `createStatic` requires `kyc` and raises `KycRequiredError` before any network call if the
selected provider needs a field that is missing — Fincra requires BVN for NGN permanent accounts, and
corporate accounts additionally need a `bvnName` matching the BVN. Capability metadata per provider
records exactly which identity fields are mandatory, so this fails fast and locally with a clear
message instead of as an opaque provider rejection.

### Inflow edge cases

Pay-by-transfer is where real money goes wrong, so each case is a **named, configurable rule**
rather than something each developer rediscovers. Korapay is the only provider that documents
guidance here at all; the rest leave it to you.

```ts
pay.webhooks.handler({
  inflowRules: {
    overpayment:  "credit_full",     // credit_full | credit_expected | reject | manual_review
    underpayment: "manual_review",   // credit_partial | reject | manual_review
    latePayment:  "accept",          // accept | reject | manual_review
    duplicate:    "ignore",          // always ignore; idempotency store decides
  },
});
```

The normalised inflow event carries what you need to apply them:
`expectedAmount`, `amountPaid`, `variance`, `isOverpayment`, `isUnderpayment`, `isLate`,
`sender: { name, bank, accountNumber }`, `sessionId`, `fees`, `settledAmount`. `sender.accountNumber`
is masked in every log and error path.

## 3. Sub-accounts — two different things, two different namespaces

The single most common source of confusion in this space, so the API refuses to blur them.

### 3a. `pay.splitAccounts` — split payments (marketplaces, platforms)

Money is settled to someone else's **external bank account**. No account is opened.

```ts
const vendor = await pay.splitAccounts.create({
  businessName: "Ada's Fabrics",
  settlementAccount: { bankCode: "058", accountNumber: "0123456789" },
  // name resolution runs first and must match, unless skipNameCheck is set
  percentageCharge: 2.5,
  settlementSchedule: "auto",
});

const split = await pay.splits.create({
  name: "order_01HQ marketplace split",
  type: "percentage",                       // "percentage" | "flat"
  currency: "NGN",
  parties: [
    { account: vendor.code, share: 9_000 }, // 90.00% as basis points, integers only
    { account: "ACCT_other", share: 500 },
  ],
  feeBearer: "all_proportional",            // main | subaccount | all | all_proportional
});
```

Shares are **integers in basis points** for percentage splits and `Money` for flat splits. No
floats, no `0.1 + 0.2`. `pay.splits.preview(amount, split)` returns the exact per-party kobo
breakdown before you use it, including who absorbs the fee and where the rounding remainder lands.

Also `update`, `list`, `deactivate`, `settlements(code, { from, to })`.

### 3b. `pay.wallets` — wallet / banking sub-accounts (fintechs, BaaS)

A **real deposit account (NUBAN)** is opened under your main account, and it holds a balance.

```ts
const customer = await pay.wallets.onboardCustomer({
  type: "individual",                     // "individual" | "business"
  name: { first: "Ada", last: "Obi" },
  email, phone, dateOfBirth,
  kyc: { bvn, nin, tier: 2 },
});

const wallet = await pay.wallets.open({ customer: customer.id, currency: "NGN" });
// → { id, accounts: BankAccount[], balance: Money, kycTier, status }

await pay.wallets.balance(wallet.id);
await pay.wallets.statement(wallet.id, { from, to });
await pay.wallets.transfer({                 // book transfer, stays inside the provider
  from: wallet.id, to: otherWallet.id, amount: naira(2_000), reference, narration,
});
await pay.wallets.freeze(wallet.id, { reason });
await pay.wallets.unfreeze(wallet.id);
await pay.wallets.close(wallet.id);
```

`pay.wallets` is implemented by the BaaS providers (Anchor, Safe Haven, Lenco) and by the gateways
that genuinely offer it (Korapay pool accounts and account-holders, Flutterwave payout subaccounts,
Monnify sub-accounts subject to their approval gate, Paga subsidiary accounts). On Paystack, every
`pay.wallets.*` call raises `UnsupportedOperationError` immediately — Paystack has no such product,
and pretending otherwise would be the worst thing this SDK could do.

## 4. Payouts

```ts
const banks = await pay.banks.list();                 // normalised CBN/NIBSS codes
const resolved = await pay.banks.resolveAccount({ bankCode: "058", accountNumber: "0123456789" });

const payout = await pay.payouts.create({
  amount: naira(25_000),
  recipient: { bankCode: "058", accountNumber: "0123456789", name: resolved.accountName },
  reference: "payout_01HQ...",            // doubles as the idempotency key
  narration: "Vendor settlement Oct",
});

await pay.payouts.status("payout_01HQ...");
await pay.payouts.createBulk({ reference, items: [...] });
await pay.balance.get();
```

Bank codes come from naija-data, generated into the package at build time. The build **fails** if any
provider's published bank list contains a bank that cannot be mapped to a CBN/NIBSS code; the report
names the unmapped banks so they become a naija-data issue rather than a silent gap. `bankSlug`
preserves provider-specific identifiers (`titan-paystack`, `habari`) for round-tripping.

**Payouts are never retried automatically.** They are not idempotent at the provider in any
documented way we trust. A `NetworkError` on a payout returns a distinct
`PayoutStatusUnknownError` that tells the caller to query status by reference, and the docs say
plainly: never retry a payout blind.

## 5. Recurring billing and direct debit

```ts
await pay.plans.create({ name, amount: naira(5_000), interval: "monthly" });
await pay.subscriptions.create({ plan, customer, authorization });
await pay.charges.chargeAuthorization({ authorization, amount, reference });

await pay.mandates.create({ customer, account, amount: naira(50_000), type: "variable" });
await pay.mandates.status(code);
await pay.mandates.debit({ mandate: code, amount: naira(12_000), reference, narration });
await pay.mandates.cancel(code);
```

Mandate support differs sharply: Korapay distinguishes fixed from variable authorizations, Monnify
has a full mandate lifecycle, Flutterwave's e-mandate is v3-only, Remita's RRR mandates are Tier 2.
`type: "fixed" | "variable"` is capability-checked per provider.

## 6. Webhooks

One normalised, typed event shape from every provider, with the raw payload retained.

```ts
const event = await pay.webhooks.parse({
  rawBody,                      // Buffer / bytes — never the parsed object
  headers,
  provider: "paystack",         // or omitted: detected from the headers
});
```

```ts
interface NaijaPayEvent {
  id: string;                   // stable per provider event, for idempotency
  type: EventType;
  occurredAt: Date;
  provider: string;
  signatureStrength: "full-body" | "partial-body" | "shared-secret" | "unverified";
  data: Transaction | VirtualAccountInflow | Payout | Refund | Subscription | Mandate | Settlement;
  raw: unknown;
}

type EventType =
  | "payment.successful" | "payment.failed" | "payment.pending" | "payment.reversed"
  | "virtual_account.credited" | "virtual_account.assigned" | "virtual_account.assignment_failed"
  | "transfer.successful" | "transfer.failed" | "transfer.reversed"
  | "refund.processed" | "refund.failed"
  | "subscription.created" | "subscription.disabled" | "subscription.charge_failed"
  | "mandate.approved" | "mandate.cancelled" | "mandate.debited"
  | "subaccount.settled"
  | "customer.identification_succeeded" | "customer.identification_failed"
  | "unknown";
```

`"unknown"` is deliberate: an event type we have not mapped is still delivered, verified, with its
raw payload, rather than being dropped. A provider adding an event must never break a running app.

**Verification.** Each adapter implements its documented scheme over the **raw bytes**, with
constant-time comparison. Fincra and Korapay re-serialise by design; for those we try raw bytes
first, fall back to canonical compact JSON, and record which path matched so drift is visible.
Where a provider's scheme is undocumented (Squad, Monnify today), `parse` raises
`WebhookVerificationError` unless the application explicitly opts in with
`allowUnverified: true` — in which case `signatureStrength` is `"unverified"` and that is loudly
logged. We will not fake a verification we cannot perform.

**Idempotency and replay.**

```ts
const handler = pay.webhooks.handler({
  store: redisStore(redis),                 // or memoryStore() for dev
  reverifyBeforeGivingValue: true,          // DEFAULT ON
  maxAgeSeconds: 300,                       // replay window where the provider gives a timestamp
  inflowRules: { ... },
  on: {
    "payment.successful": async (e) => { ... },
    "virtual_account.credited": async (e) => { ... },
  },
});
```

`reverifyBeforeGivingValue` re-queries the provider's own API for the referenced transaction before
any handler runs, and will not dispatch if the API disagrees with the webhook. Given that
Flutterwave v3 offers no payload integrity at all and two more providers' schemes are undocumented,
this is the only responsible default.

**Ready-made handlers**, each a thin adapter over the same core:
Express, Fastify, Next.js route handler, Hono/edge (TypeScript); Django, Django REST Framework,
FastAPI, Flask (Python). Each one's only job is to hand over the untouched raw body — the single
mistake that breaks signature verification in every language.

## 7. Router, fees, reconciliation

```ts
const pay = new NaijaPay({
  providers: [paystack({...}), flutterwave({...}), monnify({...})],
  router: {
    strategy: "priority",          // "priority" | "cheapest" | "channel"
    order: ["paystack", "flutterwave", "monnify"],
    failover: { on: ["provider_down", "rate_limited", "network"], maxProviders: 2 },
    circuitBreaker: { failureThreshold: 5, resetAfterMs: 30_000, halfOpenRequests: 1 },
  },
});
```

**Which operations may fail over, and which may never.** This is a money-safety question, so it is
a hard rule in code, not configuration:

| Operation | Failover | Why |
| --- | --- | --- |
| Create checkout / virtual account | **Yes** | No money has moved; the customer simply gets a different page or account |
| Verify, get, list, bank list, resolve account | **Yes** | Read-only |
| Create split account, plan, customer | **Yes** | Idempotent by reference |
| **Payout / transfer** | **Never** | Failing over could pay twice. A failed payout surfaces as `PayoutStatusUnknownError`; the caller checks status |
| **Mandate debit** | **Never** | Same reason |
| **Refund** | **Never** | Same reason |
| Webhook handling | N/A | Events belong to the provider that sent them |

A failover attempt is always visible in logs and in the returned object's `routing` field
(`attempted`, `succeededWith`, `reason`). Silent failover on a money-moving call is exactly the kind
of bug that destroys trust in an SDK, so the only answer is that it cannot happen.

**Fees.** `pay.fees.estimate({ amount, channel, provider })` returns the fee from published pricing,
with `verifiedOn` and a `source` URL on every entry. Pricing tables live in versioned JSON with the
verification date, and the weekly workflow flags any table older than 90 days. The docs say clearly
that these are estimates from published pricing and that negotiated rates differ.

**Reconciliation.**

```ts
const report = await pay.reconcile({
  from, to,
  records: myLedgerRows,       // { reference, amount, status }
});
// → { matched[], missingFromProvider[], missingFromRecords[], amountMismatch[], statusMismatch[] }
```

## 8. Testing tools

**Mock provider**, in both languages, covering every operation above and every edge case —
success, failure, pending, overpayment, underpayment, late payment, duplicate delivery, reversal,
KYC rejection, rate limiting, provider-down:

```ts
import { mock } from "naija-pay/mock";

const pay = new NaijaPay({ providers: [mock({ webhookUrl: "http://localhost:3000/webhooks" })] });
await pay.mock.simulate.inflow({ account, amount: naira(5_000), overpayBy: naira(500) });
```

The mock signs the webhooks it sends with a configurable scheme, so a developer can test the whole
loop — including signature verification — with no provider account at all.

**CLI** (ships with the npm package, and as `naija-pay` on PyPI):

```
naija-pay verify <reference>
naija-pay banks [--search wema]
naija-pay resolve <accountNumber> <bankCode>
naija-pay va create --customer ada@example.com --bvn ...
naija-pay webhook test --provider paystack --event payment.successful --url http://localhost:3000/hook
naija-pay doctor            # checks keys, environment, connectivity, clock skew
```

`naija-pay doctor` exists because the two most common support questions in this space are "my
signature does not verify" (raw body, or clock) and "am I on test or live".

## 9. Security posture

- **Never touches raw card data.** No PAN, CVV or expiry crosses this SDK's surface.
- **Redaction by default.** A field-name and pattern-based redactor masks BVN, NIN, account numbers,
  card tokens, keys and bearer tokens in every log line, error message and exception repr, before
  anything leaves the process. Tests assert that a known BVN never appears in any output path.
- **Keys from config or environment only.** Never from a file the SDK finds by itself, never
  persisted, never echoed back.
- **Constant-time comparison** for every signature check.
- **Request signing and encryption** where providers require it (Flutterwave encryption key,
  Safe Haven's signed client assertion), behind the same adapter interface.
- **TypeScript: zero runtime dependencies**, built on `fetch`. **Python: `httpx` only.** Lockfiles
  committed, Dependabot on, npm provenance, PyPI trusted publishing, and a SECURITY.md with private
  vulnerability reporting.

## 10. Parity between the two languages

A single set of JSON fixtures under `fixtures/` drives both test suites. Each fixture is a recorded
provider request/response pair plus the normalised object it must produce. The parity test asserts
that the TypeScript and Python adapters produce **byte-identical normalised JSON** from the same
fixture. If the two languages ever disagree about what a Paystack webhook means, CI fails.

The same fixtures are what let a weekly sandbox run detect provider drift: when a real sandbox
response stops matching the recorded fixture, the workflow opens an issue naming the provider, the
operation and the diff.
