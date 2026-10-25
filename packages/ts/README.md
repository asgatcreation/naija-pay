# @asgatcreation/naija-pay

One typed interface to every Nigerian payment and banking-as-a-service provider:
collections, virtual accounts, split payments, customer wallets, payouts, recurring
billing and webhooks.

```bash
npm install @asgatcreation/naija-pay
```

```ts
import { NaijaPay, naira } from "@asgatcreation/naija-pay";
import { paystack } from "@asgatcreation/naija-pay/paystack";

const pay = new NaijaPay({
  providers: [paystack({ secretKey: process.env.PAYSTACK_SECRET_KEY })],
});

const checkout = await pay.checkout.create({
  amount: naira(5_000),
  reference: "order_01HQ",
  customer: { email: "ada@example.com" },
});
```

ESM and CJS, full types, runs on Node, Bun, Deno and edge runtimes, **zero runtime
dependencies**, and tree-shakeable — each provider is its own entry point, so your
bundle only contains the ones you import.

> **Pre-release.** Not yet published to npm, and no provider adapter is sandbox-verified yet.

Full documentation, the provider capability matrix and the API contract are in the
[project repository](https://github.com/asgatcreation/naija-pay).

MIT © Akanji Oluwaseun Gabriel
