## What this changes

<!-- One or two sentences. Why, not just what. -->

## Checklist

- [ ] No secrets, keys, BVNs, NINs or account numbers anywhere in the diff
- [ ] Amounts are integers in the currency's minor unit — no floats, including in fixtures
- [ ] `npm run check` passes locally (TypeScript tests, Python tests, cross-language parity)
- [ ] Unit tests added or updated, and they make no network calls

## If this touches a provider

- [ ] Facts came from the provider's **current official docs**, not from memory or another SDK
- [ ] [PROVIDERS.md](../PROVIDERS.md) updated, including the docs URL and **the date verified**
- [ ] Anything the docs get wrong or leave out is recorded under "Findings to encapsulate"
- [ ] Implemented in **both** TypeScript and Python, with the same concepts and naming
- [ ] Fixtures recorded for every operation and event, with the raw webhook bytes preserved
- [ ] Capability declaration updated, including `requiresApproval` for commercially gated features
- [ ] Sandbox-verified, or clearly stated below that it is not

## If this touches webhooks

- [ ] Verification is over the **raw bytes** and uses constant-time comparison
- [ ] `signatureStrength` is correct for this provider's actual scheme
- [ ] A tampered-body test proves verification fails

## If this touches money movement

- [ ] Payouts, refunds and mandate debits are still never retried automatically
- [ ] They are still never failed over between providers
- [ ] Split and fee arithmetic still cannot lose or invent a kobo

## Notes for the reviewer

<!-- Anything you are unsure about, or deliberately left out. -->
