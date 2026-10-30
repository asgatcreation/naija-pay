/**
 * Redaction.
 *
 * BVNs, NINs, account numbers and credentials must never reach a log line, an error
 * message, an exception's string form, or a crash reporter. Under the Nigeria Data
 * Protection Act 2023 these are personal data; a leaked key is worse still.
 *
 * Redaction is on by default and applied at construction time of anything that could
 * be printed, rather than at the point of logging. A path that forgets to redact is
 * then impossible, instead of merely discouraged.
 *
 * IMPORTANT: never redact a webhook body before verifying its signature. Signatures
 * are computed over exact bytes, so masking first guarantees a mismatch. Verify, then
 * redact for logging. The webhook parser enforces that order.
 */

/** Replacement for a value that is masked in full. */
const FULL_MASK = "[redacted]";

/**
 * Keep the first and last few characters so a human can still correlate records, and
 * mask the middle. This is the convention the providers themselves use — Paystack
 * returns `"bvn": "123*****456"` in its identification webhooks.
 */
function maskMiddle(value: string, keepStart = 3, keepEnd = 3): string {
  if (value.length <= keepStart + keepEnd) return "*".repeat(value.length);
  const masked = "*".repeat(value.length - keepStart - keepEnd);
  return value.slice(0, keepStart) + masked + value.slice(value.length - keepEnd);
}

/**
 * Credential patterns, keyed by provider convention. Each captures a recognisable
 * prefix so the masked output still tells you *which* credential was involved — a
 * leaked `sk_live_` is a different emergency from a leaked `sk_test_`.
 */
const CREDENTIAL_PATTERNS: readonly { readonly re: RegExp; readonly label: string }[] = [
  // Paystack, Korapay, Squad: sk_test_…, sk_live_…, pk_…, sandbox_sk_…
  { re: /\b(sandbox_)?(sk|pk)_(test|live)_[A-Za-z0-9]{4,}/g, label: "$&" },
  { re: /\b(sandbox_)?(sk|pk)_[A-Za-z0-9]{8,}/g, label: "$&" },
  // Flutterwave: FLWSECK_TEST-…, FLWSECK-…, FLWPUBK_TEST-…
  { re: /\bFLW(SECK|PUBK)(_TEST)?-[A-Za-z0-9-]{4,}/g, label: "$&" },
  // Monnify: MK_TEST_…, MK_PROD_…
  { re: /\bMK_(TEST|PROD)_[A-Za-z0-9]{4,}/g, label: "$&" },
  // Bearer and Basic authorization header values
  { re: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, label: "$&" },
  // JWTs and anything else shaped like one
  { re: /\beyJ[A-Za-z0-9._-]{16,}/g, label: "$&" },
];

/**
 * An 11-digit run is a BVN or a NIN; a 10-digit run is a NUBAN account number.
 *
 * Bounded by non-digits so that a long amount in minor units is not mistaken for an
 * identifier. Amounts are integers in JSON rather than strings, so they do not
 * normally travel through here at all.
 */
const ELEVEN_DIGITS = /(?<!\d)\d{11}(?!\d)/g;
const TEN_DIGITS = /(?<!\d)\d{10}(?!\d)/g;

/** Card numbers: 13 to 19 digits, optionally grouped. Must never appear at all. */
const CARD_NUMBER = /(?<!\d)(?:\d[ -]?){13,19}(?!\d)/g;

/**
 * Field names whose values are masked in full, matched case-insensitively and ignoring
 * separators, so `secret_key`, `secretKey` and `SECRET-KEY` are all caught.
 */
const FULLY_MASKED_FIELDS: ReadonlySet<string> = new Set([
  "secretkey",
  "apikey",
  "publickey",
  "encryptionkey",
  "webhooksecret",
  "secrethash",
  "secret",
  "secrettoken",
  "token",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "clientsecret",
  "password",
  "authorization",
  "auth",
  "signature",
  "pan",
  "cardnumber",
  "cvv",
  "cvc",
  "expiry",
  "expirymonth",
  "expiryyear",
  "pin",
]);

/** Field names whose values are partially masked, keeping them correlatable. */
const PARTIALLY_MASKED_FIELDS: ReadonlySet<string> = new Set([
  "bvn",
  "nin",
  "vnin",
  "accountnumber",
  "accountno",
  "nuban",
  "destinationaccountnumber",
  "sourceaccountnumber",
  "sendderaccountnumber",
  "senderaccountnumber",
  "counterpartyaccountnumber",
  "phone",
  "phonenumber",
  "mobile",
  "msisdn",
]);

const normaliseFieldName = (name: string): string => name.replace(/[^a-z0-9]/gi, "").toLowerCase();

/**
 * Mask credentials and identifiers inside a free-text string.
 *
 * Used on every error message and every log message. Order matters: credentials are
 * masked before digit runs, so a key containing digits is not partially rewritten
 * first.
 */
export function redact(text: string): string {
  if (typeof text !== "string" || text.length === 0) return text;

  let out = text;

  for (const { re } of CREDENTIAL_PATTERNS) {
    out = out.replace(re, (match) => {
      // Keep a short recognisable prefix so the masked form still identifies which
      // credential leaked, without revealing enough to use it.
      const prefixMatch =
        /^(sandbox_sk_|sandbox_pk_|sk_test_|sk_live_|pk_test_|pk_live_|sk_|pk_|FLWSECK_TEST-|FLWSECK-|FLWPUBK_TEST-|FLWPUBK-|MK_TEST_|MK_PROD_|Bearer\s+|Basic\s+|eyJ)/i.exec(
          match,
        );
      const prefix = prefixMatch ? prefixMatch[0] : "";
      return `${prefix}${FULL_MASK}`;
    });
  }

  out = out.replace(CARD_NUMBER, (match) => {
    // Only treat it as a card number if it really is 13+ digits once separators go.
    const digits = match.replace(/[ -]/g, "");
    return digits.length >= 13 ? FULL_MASK : match;
  });

  out = out.replace(ELEVEN_DIGITS, (m) => maskMiddle(m));
  out = out.replace(TEN_DIGITS, (m) => maskMiddle(m));

  return out;
}

/** Mask an account number for display, keeping the ends. */
export function maskAccountNumber(accountNumber: string): string {
  return maskMiddle(accountNumber);
}

/** Mask a BVN or NIN for display, keeping the ends. */
export function maskIdentityNumber(value: string): string {
  return maskMiddle(value);
}

/**
 * Deep-redact a structure for logging.
 *
 * Returns a new value; the input is never mutated, because callers hand us objects
 * they still intend to use. Sensitive field names are masked by name, and every
 * remaining string is still passed through the pattern redactor — a BVN in a `reason`
 * field is just as sensitive as one in a `bvn` field.
 */
export function redactObject<T>(value: T, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return redact(value);
  if (value === null || typeof value !== "object") return value;

  // Cycles appear in real payloads once objects carry back-references.
  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (Array.isArray(value)) return value.map((v) => redactObject(v, seen));

  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const name = normaliseFieldName(key);
    if (FULLY_MASKED_FIELDS.has(name)) {
      out[key] = FULL_MASK;
    } else if (PARTIALLY_MASKED_FIELDS.has(name)) {
      out[key] = typeof raw === "string" ? maskMiddle(raw) : FULL_MASK;
    } else {
      out[key] = redactObject(raw, seen);
    }
  }
  return out;
}

/**
 * Detect whether a string looks like a live (production) credential.
 *
 * Used for the loud warning when a live key turns up outside production. Paystack in
 * particular serves test and live from the same host, so the key is the only signal
 * that real money is about to move.
 */
export function looksLikeLiveKey(value: string): boolean {
  if (typeof value !== "string") return false;
  return (
    /\b(sk|pk)_live_/.test(value) ||
    (/\bFLWSECK-/.test(value) && !/_TEST-/.test(value)) ||
    /\bMK_PROD_/.test(value)
  );
}

/** Detect whether a string looks like a test/sandbox credential. */
export function looksLikeTestKey(value: string): boolean {
  if (typeof value !== "string") return false;
  return (
    /\b(sk|pk)_test_/.test(value) ||
    /\bsandbox_(sk|pk)_/.test(value) ||
    /\bFLW(SECK|PUBK)_TEST-/.test(value) ||
    /\bMK_TEST_/.test(value)
  );
}
