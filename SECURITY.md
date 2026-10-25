# Security policy

naija-pay moves money and handles personal data covered by the Nigeria Data Protection Act 2023.
Security reports are taken seriously and handled privately.

## Reporting a vulnerability

**Do not open a public issue.**

Use GitHub's private vulnerability reporting:

1. Go to <https://github.com/asgatcreation/naija-pay/security/advisories/new>
2. Describe the issue, the affected version, and how to reproduce it.

If that is not available to you, email **asgatcreation@gmail.com** with "naija-pay security" in the
subject line.

Please include, as far as you can: the affected version and provider adapter, what an attacker can
achieve, and a minimal reproduction. **Never include a real secret key, a real BVN or NIN, or a real
account number** in a report — redact them, or describe the shape of the data instead.

## What to expect

- Acknowledgement within **3 days**.
- An initial assessment within **7 days**.
- A fix and an advisory for confirmed issues, crediting you unless you prefer otherwise.

Please give a reasonable window to ship a fix before disclosing publicly.

## Especially interested in

These are the areas where a bug would hurt most:

- **Webhook verification** — a signature that verifies when it should not, a timing side channel, a
  canonicalisation mismatch that lets a tampered body through.
- **Redaction** — a path where a BVN, NIN, account number, key or token reaches a log, an error
  message, an exception repr or a stack trace.
- **Idempotency and replay** — anything that could cause a webhook to be processed twice, or a
  payment to be credited twice.
- **Retry and failover safety** — anything that could cause a payout, refund or mandate debit to be
  sent twice. These operations are never retried or failed over by design; a hole in that is a
  serious bug.
- **Money arithmetic** — a split, fee or rounding path that loses or invents value.
- **Key handling** — a live key accepted where a test key was expected, or a key written to disk or
  to output.

## Scope

In scope: this repository's TypeScript and Python packages, the CLI, the webhook handlers, and the
example apps.

Out of scope: vulnerabilities in the payment providers' own APIs or dashboards — report those to the
provider directly. If a provider's **documented** scheme is itself weak, that is not a naija-pay
vulnerability, but please do tell us: we document such cases (see the webhook table in
[PROVIDERS.md](PROVIDERS.md)) and surface them through `signatureStrength` so users can act on them.

## Supported versions

While the project is pre-1.0, only the latest release receives fixes. After 1.0, the current major
version is supported.
