# naija-pay

**One typed interface to every Nigerian payment and banking-as-a-service provider.**
Collections, virtual accounts, split payments, customer wallets, payouts, recurring billing and
webhooks — for TypeScript and Python.

[![CI](https://github.com/asgatcreation/naija-pay/actions/workflows/ci.yml/badge.svg)](https://github.com/asgatcreation/naija-pay/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Status: pre-release](https://img.shields.io/badge/status-pre--release-orange)

> **Pre-release.** Nothing is published to npm or PyPI yet, and no provider adapter is
> sandbox-verified. Follow the milestones in [PLAN.md](PLAN.md). The API in
> [DESIGN.md](DESIGN.md) is the contract we are building to.

---

## Why this exists

Today, every Nigerian startup writes separate, fragile integration code for each payment provider.
The field names differ. The bank codes differ. The error shapes differ. And the webhook signatures
differ so much that getting them right is a research project in itself:

| Provider | Webhook header | Algorithm | Signed over |
| --- | --- | --- | --- |
| Paystack | `x-paystack-signature` | HMAC-SHA512, hex | raw body |
| Flutterwave v4 | `flutterwave-signature` | HMAC-SHA256, base64 | raw body |
| Flutterwave v3 | `verif-hash` | none — literal string comparison | **nothing** |
| Fincra | `signature` | HMAC-SHA512, hex | re-serialised `{event, data}` |
| Korapay | `x-korapay-signature` | HMAC-SHA256, hex | the `data` object **only** |
| Anchor | `x-anchor-signature` | HMAC-**SHA1**, base64 | body |
| Monnify | undocumented | undocumented | — |
| Squad | `x-squad-encrypted-body` | **undocumented** | — |

Seven providers, seven schemes, three hash algorithms, two encodings, two kinds of key — and three
where the published documentation does not let you verify correctly at all. Every one of these is
hand-written separately, in every company, right now.

naija-pay normalises all of it, and tells you how strong each verification actually was instead of
pretending they are equivalent. Switching provider, or running several with automatic failover,
becomes a one-line change.

Every fact above was read from the providers' own current documentation, with the date recorded, in
[PROVIDERS.md](PROVIDERS.md).

## Install

```bash
npm install @asgatcreation/naija-pay
```

```bash
pip install naija-pay
```

TypeScript ships ESM and CJS with full types, runs on Node, Bun, Deno and edge runtimes, and has
**zero runtime dependencies**. Each provider is its own entry point, so your bundle only contains
the ones you import. Python ships sync and async clients with full type hints under `mypy --strict`,
and depends only on `httpx`.

## Accept a payment

```ts
import { NaijaPay, naira } from "@asgatcreation/naija-pay";
import { paystack } from "@asgatcreation/naija-pay/paystack";

const pay = new NaijaPay({
  providers: [paystack({ secretKey: process.env.PAYSTACK_SECRET_KEY })],
});

const checkout = await pay.checkout.create({
  amount: naira(5_000),                 // 500000 kobo — integers only, never floats
  reference: "order_01HQ",
  customer: { email: "ada@example.com" },
  channels: ["card", "bank_transfer", "ussd"],
});

console.log(checkout.checkoutUrl);

const txn = await pay.transactions.verify("order_01HQ");
if (txn.status === "successful") { /* give value */ }
```

```python
from naija_pay import NaijaPay, naira
from naija_pay.providers import paystack

pay = NaijaPay(providers=[paystack(secret_key=os.environ["PAYSTACK_SECRET_KEY"])])

checkout = pay.checkout.create(
    amount=naira(5_000),
    reference="order_01HQ",
    customer={"email": "ada@example.com"},
    channels=["card", "bank_transfer", "ussd"],
)

txn = pay.transactions.verify("order_01HQ")
```

## Create a virtual account

Static accounts belong to a customer and need KYC. Dynamic accounts belong to one transaction and
expire. They are separate methods, because confusing them is a real production bug.

```ts
const va = await pay.virtualAccounts.createStatic({
  customer: { email: "ada@example.com", name: "Ada Obi" },
  kyc: { bvn: "22222222222" },          // required by CBN rules on most providers
  preferredBank: "wema",
});

console.log(va.accounts);  // [{ accountNumber, accountName, bankName, bankCode }]
```

```python
va = pay.virtual_accounts.create_static(
    customer={"email": "ada@example.com", "name": "Ada Obi"},
    kyc={"bvn": "22222222222"},
    preferred_bank="wema",
)
```

Overpayment, underpayment, late payment and duplicate notifications are each a documented,
configurable rule — not something you rediscover in production.

## Split to a sub-account

```ts
const vendor = await pay.splitAccounts.create({
  businessName: "Ada's Fabrics",
  settlementAccount: { bankCode: "058", accountNumber: "0123456789" },
});

const split = await pay.splits.create({
  name: "marketplace",
  type: "percentage",
  currency: "NGN",
  parties: [{ account: vendor.code, share: 9_000 }],   // basis points, integers
  feeBearer: "all_proportional",
});

pay.splits.preview(naira(10_000), split);   // exact per-party kobo, before you use it
```

naija-pay keeps the **two different kinds of sub-account** strictly apart: `pay.splitAccounts` settles
to someone's external bank account, while `pay.wallets` opens a real NUBAN deposit account that holds
a balance. On a provider that has no wallet product, `pay.wallets.*` fails loudly instead of
pretending.

## Verify a webhook

```ts
import express from "express";

const app = express();
app.post(
  "/webhooks",
  express.raw({ type: "application/json" }),     // raw body — this is the usual mistake
  pay.webhooks.expressHandler({
    reverifyBeforeGivingValue: true,             // default on
    on: {
      "payment.successful": async (e) => { /* e.data is a typed Transaction */ },
      "virtual_account.credited": async (e) => { /* typed inflow, with sender and variance */ },
    },
  }),
);
```

```python
from naija_pay.frameworks.fastapi import webhook_router

app.include_router(webhook_router(pay, on={
    "payment.successful": handle_payment,
    "virtual_account.credited": handle_inflow,
}))
```

Every event arrives in one normalised, typed shape, keeps its raw payload, and carries
`signatureStrength` so you can refuse to act on a weak one. Ready-made handlers for Express,
Fastify, Next.js and Hono/edge; Django, DRF, FastAPI and Flask.

## Test the whole flow before you have any provider account

The mock provider signs its webhooks with a real scheme, so the verification code that runs in
production runs here too. Nothing is stubbed out on the security path.

```ts
import { mock, INFLOW_SCENARIOS } from "@asgatcreation/naija-pay/mock";
import { verifySignature } from "@asgatcreation/naija-pay";

const provider = mock();

// Money arrives in a virtual account — 500 naira more than the invoice asked for
const webhook = await provider.simulateInflow({
  expectedAmount: naira(5_000),
  amountPaid: naira(5_500),
});

await provider.deliver(webhook, "http://localhost:3000/webhooks");
```

Every awkward case is a ready-made scenario, because these are exactly the ones each provider
leaves to you: exact payment, overpayment, underpayment, static-account funding with no expected
amount, payment after the account expired, and late-and-underpaid at once. Duplicate delivery and
a deliberately invalid signature are both reachable too.

```python
from naija_pay.providers import mock

provider = mock()
webhook = provider.simulate_inflow(expected_amount=naira(5_000), amount_paid=naira(4_900))
assert webhook.event.data["variance"] == "underpayment"
```

The mock's wire payload is byte-identical in both languages, so a fixture recorded from it drives
either test suite.

## Capability matrix

Which provider supports what — generated from the adapters themselves, so it cannot go stale.
See the full table in [PROVIDERS.md](PROVIDERS.md#capability-matrix).

**Tier 1 (v1.0):** Paystack, Flutterwave, Monnify, Fincra, Squad, Korapay.
**Tier 2 (after 1.0):** Nomba, Paga, Interswitch, Remita, Budpay, PalmPay, Credo.
**Tier 3, banking-as-a-service:** Anchor, Safe Haven MFB, Lenco, and more on request.

## Why it is safe to use with real money

- **Money is an integer in kobo. Always.** No floats anywhere, not even in fixtures. Split maths is
  exact, and the rounding remainder goes to the main account by a documented rule.
- **Raw card data is never touched.** Hosted and inline checkout only, so your PCI DSS scope stays
  at SAQ A. The docs explain exactly what that means.
- **BVN, NIN and account numbers are redacted automatically** from every log line, error message and
  exception — tested, not promised. Relevant to NDPA 2023.
- **Retries only where they are safe.** Payouts, refunds and mandate debits are never retried
  automatically and never failed over between providers, because that could pay twice. A failed
  payout tells you to check status rather than guessing.
- **Signature verification is constant-time**, over the raw bytes, and honest about its own strength.
- **Test and live keys are detected**, with a loud warning if a live key is used outside production.
- **Minimal dependencies**, lockfiles, Dependabot, npm provenance and PyPI trusted publishing.

## Compared with using each official SDK

| | Official SDKs, one per provider | naija-pay |
| --- | --- | --- |
| Interfaces to learn | One per provider | One |
| Amounts | Kobo, naira or float, depending | Integer kobo, enforced |
| Webhook verification | Yours to write, 7 different ways | One call, with a strength rating |
| Switching provider | A rewrite | A one-line config change |
| Several providers with failover | Build it yourself | Built in, and it refuses to fail over a payout |
| Bank codes | Each provider's own | Normalised CBN/NIBSS codes |
| Testing without keys | Not possible | Mock provider that sends signed webhooks |
| Virtual account edge cases | Rediscovered in production | Documented, configurable rules |
| Typed errors | Rarely | Always, keeping the provider's original code |

## Documentation

- [PROVIDERS.md](PROVIDERS.md) — every provider's verified facts, the capability matrix, webhook
  schemes, sandbox availability, and the date each was checked.
- [DESIGN.md](DESIGN.md) — the normalised API contract.
- [PLAN.md](PLAN.md) — milestones and current status.
- [CONTRIBUTING.md](CONTRIBUTING.md) — including the checklist for adding a provider.
- [SECURITY.md](SECURITY.md) — how to report a vulnerability privately.

## Pairs with naija-data

Bank codes come from [naija-data](https://github.com/asgatcreation/naija-data), an open dataset of
Nigerian reference data with packages for Python, JS/TS and Go. naija-pay generates its bank tables
from it **at build time**, so there is no runtime dependency — and the build fails if a provider
returns a bank that cannot be mapped to a CBN/NIBSS code, rather than letting the gap go unnoticed.

## Contributing

Adding a provider is a checklist, not an archaeology project — see [CONTRIBUTING.md](CONTRIBUTING.md).
Bug reports, provider API-change reports and new-provider requests all have issue templates.

## Not affiliated

naija-pay is an independent open-source project. It is **not affiliated with, endorsed by, or
sponsored by** any provider it integrates with. All product and company names are the trademarks of
their respective owners.

## Licence

MIT © Akanji Oluwaseun Gabriel

Created and maintained by **Akanji Oluwaseun Gabriel** ([@asgatcreation](https://github.com/asgatcreation)).
