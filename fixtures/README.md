# Fixtures

These recorded request/response pairs are the **shared source of truth for both languages**. The
TypeScript and Python test suites run against the same files and must produce byte-identical
normalised output. If the two ever disagree about what a provider response means, CI fails.

Because everything here is recorded, unit tests make **no network calls**: they run offline, in CI,
with no API keys.

## Layout

```
fixtures/
├── providers/<provider>/<operation>/
│   ├── request.json       what naija-pay sends
│   ├── response.json      what the provider sent back, verbatim
│   └── normalised.json    the naija-pay object this must produce — the contract
├── webhooks/<provider>/<event>/
│   ├── headers.json       including the signature header
│   ├── body.raw           THE RAW BYTES, exactly as received
│   └── normalised.json    the NaijaPayEvent this must produce
└── pricing/<provider>.json   fee tables, with verifiedOn and a source URL
```

## Rules

1. **`body.raw` is raw bytes, never reformatted.** Do not pretty-print it, do not re-save it through
   an editor that changes line endings, do not sort its keys. Every provider's signature is computed
   over specific bytes; reformatting silently breaks verification and the test that was meant to
   catch it. This is why webhook bodies are stored as `.raw` rather than `.json`.

2. **Redact every real value.** No real keys, BVNs, NINs, account numbers, names, emails or phone
   numbers. Use the obviously-fake values already in use: BVN `22222222222`, account number
   `0123456789`, email `ada@example.com`. Where a redaction would change the signature, re-sign the
   redacted body with a test secret and record that secret in the fixture directory.

3. **Amounts are integers in the minor unit.** A float in a fixture is a bug, even if the provider
   itself sent one — record what they sent in `response.json`, and assert the integer in
   `normalised.json`.

4. **One fixture per real observation.** Record what the provider actually returned, including
   oddities. Do not tidy a response into what you think it should have been; the oddities are the
   reason this SDK exists.

5. **Note where it came from.** Each operation directory carries a `source.txt` naming the docs page
   or sandbox call it was captured from, and the date.

## Edge cases that must have fixtures

For every provider that supports virtual accounts: overpayment, underpayment, payment after expiry,
and a duplicate delivery of the same event. For every provider with splits: a percentage split, a
flat split, and a split whose division does not come out evenly in kobo. For every provider with
webhooks: a valid signature, and a tampered body that must be rejected.
