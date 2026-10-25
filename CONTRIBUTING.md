# Contributing to naija-pay

Thanks for helping. This project handles other people's money, so the bar is high — but the rules
are few and they are written down, which is the point.

## Ground rules

1. **Official documentation is the only source of truth.** Never write an endpoint, field name or
   signature scheme from memory, from a blog post, or from another SDK. Read the provider's current
   docs, and record the URL and the date you read it in [PROVIDERS.md](PROVIDERS.md).
2. **Never guess.** If the docs are unclear, test against the sandbox and write down what you
   observed. If you cannot do either, say so in the PR and mark the feature unverified. An honest
   gap is far better than a confident guess.
3. **Money is an integer in the currency's minor unit.** No floats, anywhere, including fixtures and
   tests. A PR that introduces a float for an amount will be asked to change.
4. **No secrets, ever.** Test keys only, in a gitignored `.env`. If you commit a key by accident,
   rotate it immediately and say so.
5. **No raw card data.** Nothing in this SDK may accept a PAN, CVV or expiry date.
6. **Fake credentials must contain the token `EXAMPLE`.** Tests and fixtures need
   realistic-looking keys to prove that redaction works, so write them as
   `sk_live_EXAMPLE123` or `FLWSECK-EXAMPLEdef456`. CI greps the whole tree for live-key
   shapes and ignores only matches containing `EXAMPLE`. That way the check still applies
   inside test files — which is exactly where a real key gets pasted by accident — rather
   than excluding those paths wholesale.

## Getting set up

Requires Node 24+ and Python 3.13+.

```bash
git clone https://github.com/asgatcreation/naija-pay
cd naija-pay
cp .env.example .env     # fill in TEST keys only, for the providers you have
```

```bash
npm test                 # TypeScript tests
npm run test:python      # Python tests
npm run test:parity      # both languages against the shared fixtures
```

Unit tests make **no network calls**. They run against recorded fixtures, so they work offline and in
CI without any keys. Sandbox integration tests are opt-in and need keys in `.env`.

## Adding a provider

This is the checklist. Work top to bottom; each step is small on its own.

### 1. Research first, code second

- [ ] Read the provider's **current** official docs end to end. Note the API version if they have
      more than one, and use the one they currently recommend.
- [ ] Add a section to [PROVIDERS.md](PROVIDERS.md) with: docs URL, API version, auth method, base
      URLs for test and live, webhook signing scheme, rate limits, KYC requirements, supported
      features, sandbox availability (self-serve or requires onboarding), and **the date you
      verified it**.
- [ ] Write down anything the docs get wrong or leave out, under "Findings to encapsulate". These
      findings are a feature of this project, not a side note.

### 2. Fixtures before implementation

- [ ] Record a request/response pair for every operation under
      `fixtures/providers/<provider>/<operation>/`.
- [ ] Record a raw webhook body plus its headers for every event under
      `fixtures/webhooks/<provider>/<event>/`. Keep the body as **raw bytes**, exactly as sent —
      signature verification depends on it.
- [ ] Write the `normalised.json` you expect for each. This is the contract both languages must
      satisfy.

### 3. Implement in both languages

Both `packages/ts/src/providers/<provider>/` and
`packages/python/src/naija_pay/providers/<provider>/` get the same files:

- [ ] `client` — auth, base URLs, key/environment detection
- [ ] `capabilities` — what this provider supports, including `requiresApproval` for anything behind
      a commercial gate, and which identity fields its virtual accounts need
- [ ] `collections`, `virtual-accounts`, `split-accounts`, `wallets`, `payouts`, `recurring` —
      implement what the provider has; omitted operations raise `UnsupportedOperationError`
      automatically from the capability declaration
- [ ] `webhooks` — verification over the **raw bytes**, constant-time comparison, correct
      `signatureStrength`
- [ ] `errors` — map the provider's codes onto our typed errors, always keeping `providerCode` and
      `providerMessage`

### 4. Tests

- [ ] Unit tests for every operation, from fixtures, no network.
- [ ] Webhook signature tests using the provider's **own documented example** where they publish one.
- [ ] A negative signature test: a tampered body must fail.
- [ ] Virtual account edge cases: overpayment, underpayment, late payment, duplicate delivery.
- [ ] Split maths: percentages, flat fees, and that rounding never loses or invents a kobo.
- [ ] Parity test passes — TypeScript and Python produce byte-identical normalised JSON.
- [ ] Redaction test: a known BVN and account number appear in **no** log, error or repr.

### 5. Finish

- [ ] Capability matrix regenerates cleanly (`npm run docs:matrix`).
- [ ] A docs page for the provider, including anything surprising about it.
- [ ] If you have sandbox keys, run the sandbox tests and change the provider's status in
      PROVIDERS.md to **Sandbox verified**. If you do not, leave it and say so in the PR — the
      adapter ships with `notYetSandboxVerified` until someone does.

## Reporting that a provider changed their API

Providers change things without warning, so this is one of the most useful contributions. Use the
**Provider API change** issue template and include the docs URL, what changed, and the date you saw
it. The weekly drift workflow opens these automatically too, but a human usually notices first.

## Commit messages and PRs

Plain, clear, imperative: `add Korapay virtual account support`, `fix Fincra webhook canonicalisation`.
Explain *why* in the body if it is not obvious. One logical change per PR. No AI attribution lines.

## Code style

Biome for TypeScript, ruff and mypy strict for Python; both run in CI. Match the surrounding code
rather than introducing a new style.

## Code of conduct

By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
