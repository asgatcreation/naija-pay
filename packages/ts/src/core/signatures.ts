/**
 * Webhook signature schemes.
 *
 * This file is where the research in PROVIDERS.md becomes code. Eight schemes across
 * seven providers, three hash algorithms, two encodings, two kinds of key — and three
 * providers whose published documentation does not let you verify correctly at all.
 *
 * Three principles:
 *
 * 1. **Verify over the raw bytes.** Signatures are computed over exact bytes, so the
 *    body must never be parsed, re-serialised or redacted first. Every function here
 *    takes `Uint8Array`, not a string or an object, to make that hard to get wrong.
 * 2. **Be honest about strength.** A scheme that proves nothing about the payload is
 *    reported as `shared-secret`, not dressed up as a signature. An application can
 *    then refuse to act on a weak one.
 * 3. **Run anywhere.** Built on WebCrypto (`crypto.subtle`), not `node:crypto`, so the
 *    same code works on Node, Bun, Deno, Cloudflare Workers and Vercel Edge. That is
 *    why these functions are async: WebCrypto's digest API is.
 *
 * Verified from each provider's current documentation on 2026-10-25; see PROVIDERS.md
 * for the per-provider detail and the dates.
 */

/**
 * How strongly a received webhook was actually verified.
 *
 * - `full-body`      HMAC over the whole raw body (Paystack, Flutterwave v4, Fincra)
 * - `partial-body`   HMAC over only part of the payload (Korapay signs `data` only,
 *                    leaving the event name unauthenticated)
 * - `shared-secret`  a secret was presented but nothing binds it to the payload, so
 *                    there is no integrity and no replay protection (Flutterwave v3)
 * - `unverified`     the provider's scheme is undocumented, or verification was
 *                    explicitly skipped (Squad and Monnify, as of 2026-10-25)
 */
export type SignatureStrength = "full-body" | "partial-body" | "shared-secret" | "unverified";

/**
 * What a provider's documented scheme actually does.
 *
 * - `hmac-hex`           HMAC over the raw body, compared as a hex string.
 *                        Paystack (SHA-512), Fincra (SHA-512), Korapay (SHA-256).
 * - `hmac-base64`        HMAC over the raw body, compared as base64.
 *                        Flutterwave v4 (SHA-256).
 * - `hmac-base64-of-hex` HMAC, hex-encoded, and *then* base64-encoded. Anchor's own
 *                        code samples do this, though its prose describes plain
 *                        base64. See PROVIDERS.md.
 * - `shared-secret`      The header is compared against a shared secret verbatim.
 *                        Nothing binds it to the payload. Flutterwave v3.
 * - `undocumented`       The provider sends a signature header but does not document
 *                        how it is computed. Squad and Monnify, as of 2026-10-25.
 */
export type SignatureKind =
  | "hmac-hex"
  | "hmac-base64"
  | "hmac-base64-of-hex"
  | "shared-secret"
  | "undocumented";

export type HashAlgorithm = "SHA-1" | "SHA-256" | "SHA-512";

export interface SignatureScheme {
  readonly kind: SignatureKind;
  /** Header carrying the signature, lowercase. */
  readonly header: string;
  readonly algorithm?: HashAlgorithm;
  /**
   * Which part of the payload is signed.
   *
   * `raw-body` is the whole body. `jsonPath` signs only a sub-object — Korapay signs
   * `data` alone, which leaves the event name unauthenticated, so that case must
   * re-serialise and is reported as `partial-body`.
   */
  readonly signs: "raw-body" | { readonly jsonPath: readonly string[] };
  /**
   * How strong this is, honestly. {@link strengthOf} derives the same value from
   * `kind` and `signs`; it is stated explicitly in each declaration so the claim is
   * reviewable rather than inferred, and a test asserts the two agree.
   */
  readonly strength: SignatureStrength;
}

/**
 * A scheme could not be applied to this body at all — as distinct from a signature
 * that simply did not match. Named identically in both languages so the parity tests
 * can compare rejections.
 */
export class SignatureSchemeError extends Error {
  override readonly name = "SignatureSchemeError";
}

const encoder = new TextEncoder();

function subtle(): SubtleCrypto {
  const c = globalThis.crypto;
  if (!c?.subtle) {
    throw new Error(
      "WebCrypto is not available in this runtime, so webhook signatures cannot be " +
        "verified. Node 18+, Bun, Deno, Cloudflare Workers and Vercel Edge all provide it.",
    );
  }
  return c.subtle;
}

/**
 * Constant-time string comparison.
 *
 * Never use `===` on a signature: it returns as soon as two bytes differ, which leaks
 * how much of a guess was correct. This accumulates the difference across every byte
 * and compares lengths separately, so the time taken does not depend on where the
 * first difference is.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  const length = Math.max(left.length, right.length);

  let difference = left.length ^ right.length;
  for (let i = 0; i < length; i++) {
    difference |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return difference === 0;
}

function toHex(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let out = "";
  for (const byte of view) out += byte.toString(16).padStart(2, "0");
  return out;
}

function toBase64(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  // btoa is standard in every runtime we support, including Node 18+.
  return btoa(binary);
}

async function hmac(
  algorithm: HashAlgorithm,
  secret: string,
  payload: Uint8Array,
): Promise<ArrayBuffer> {
  const key = await subtle().importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: algorithm },
    false,
    ["sign"],
  );
  return await subtle().sign("HMAC", key, payload);
}

/**
 * The bytes a scheme actually signs.
 *
 * For `raw-body` this is the untouched body, which is always what we want. For a
 * `jsonPath` scheme the provider signs a sub-object, so there is no choice but to parse
 * and re-serialise — a canonicalisation hazard that is documented rather than hidden.
 * Korapay's own PHP sample has to disable float precision mangling for exactly this
 * reason, which is also why naija-pay never represents money as a float.
 */
function payloadToSign(scheme: SignatureScheme, body: Uint8Array): Uint8Array {
  if (scheme.signs === "raw-body") return body;

  const path = scheme.signs.jsonPath.join(".");

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    // The runtimes word their JSON errors differently, so we raise our own: the
    // message is part of the cross-language contract the parity tests check.
    throw new SignatureSchemeError(
      `the webhook body is not valid JSON, so the signature over its "${path}" ` +
        "cannot be checked",
    );
  }

  let cursor: unknown = parsed;
  for (const key of scheme.signs.jsonPath) {
    if (cursor === null || typeof cursor !== "object") {
      throw new SignatureSchemeError(
        `the webhook body has no "${path}" to sign, so its signature cannot be checked`,
      );
    }
    cursor = (cursor as Record<string, unknown>)[key];
  }

  // Without this, a body missing the signed sub-object would serialise to the literal
  // string "undefined" and then verify against itself — accepting an unsigned event.
  if (cursor === undefined) {
    throw new SignatureSchemeError(
      `the webhook body has no "${path}" to sign, so its signature cannot be checked`,
    );
  }

  return encoder.encode(JSON.stringify(cursor));
}

/** Compute a signature for a body under a scheme. Used to verify, and by the mock. */
export async function computeSignature(
  scheme: SignatureScheme,
  body: Uint8Array,
  secret: string,
): Promise<string> {
  if (scheme.kind === "shared-secret") return secret;
  if (scheme.kind === "undocumented") {
    throw new SignatureSchemeError(
      `the signature scheme for header "${scheme.header}" is undocumented, so it cannot ` +
        "be computed. See PROVIDERS.md: this applies to Squad and Monnify, whose schemes " +
        "must be established against their sandboxes first.",
    );
  }

  const algorithm = scheme.algorithm ?? "SHA-512";
  const digest = await hmac(algorithm, secret, payloadToSign(scheme, body));

  switch (scheme.kind) {
    case "hmac-hex":
      return toHex(digest);
    case "hmac-base64":
      return toBase64(digest);
    case "hmac-base64-of-hex":
      // Anchor's samples base64-encode the hex digest STRING, not the raw digest.
      return toBase64(encoder.encode(toHex(digest)));
  }
}

export interface VerificationResult {
  readonly verified: boolean;
  readonly strength: SignatureStrength;
  /** Why it failed, for the error message. Never includes the secret. */
  readonly reason?: string;
}

/**
 * Verify a webhook signature.
 *
 * Returns a result rather than throwing, because the caller decides what an unverified
 * event means — and for Squad and Monnify today, "cannot be verified" is a legitimate
 * outcome that must not be mistaken for "verified".
 */
export async function verifySignature(options: {
  readonly scheme: SignatureScheme;
  /** The raw request body, exactly as received. Never the parsed object. */
  readonly body: Uint8Array;
  readonly headers: Readonly<Record<string, string>>;
  readonly secret: string;
}): Promise<VerificationResult> {
  const { scheme, body, headers, secret } = options;

  if (scheme.kind === "undocumented") {
    return {
      verified: false,
      strength: "unverified",
      reason:
        `the signature scheme for "${scheme.header}" is undocumented by the provider, ` +
        "so this event cannot be verified. Accept it only with the explicit " +
        "allow-unverified option, and re-verify with the API before giving value.",
    };
  }

  const provided = headers[scheme.header.toLowerCase()];
  if (provided === undefined || provided === "") {
    return {
      verified: false,
      strength: "unverified",
      reason: `the "${scheme.header}" header is missing`,
    };
  }

  let expected: string;
  try {
    expected = await computeSignature(scheme, body, secret);
  } catch (error) {
    return {
      verified: false,
      strength: "unverified",
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  if (constantTimeEqual(provided, expected)) {
    return { verified: true, strength: scheme.strength };
  }

  return {
    verified: false,
    strength: scheme.strength,
    reason:
      "the signature did not match. The usual cause is that the raw request body was " +
      "parsed or re-serialised before verification: signatures cover exact bytes.",
  };
}

/** The honest strength for a scheme, used to cross-check each declaration. */
export function strengthOf(scheme: SignatureScheme): SignatureStrength {
  if (scheme.kind === "undocumented") return "unverified";
  if (scheme.kind === "shared-secret") return "shared-secret";
  return scheme.signs === "raw-body" ? "full-body" : "partial-body";
}

/**
 * The Tier 1 schemes, each read from that provider's current documentation on
 * 2026-10-25. Adapters import these rather than restating them.
 */
export const SCHEMES = {
  paystack: {
    kind: "hmac-hex",
    header: "x-paystack-signature",
    algorithm: "SHA-512",
    signs: "raw-body",
    strength: "full-body",
  },
  /** Flutterwave v4: HMAC-SHA256 over the raw body, base64. */
  flutterwaveV4: {
    kind: "hmac-base64",
    header: "flutterwave-signature",
    algorithm: "SHA-256",
    signs: "raw-body",
    strength: "full-body",
  },
  /**
   * Flutterwave v3: the documented method is to compare the `verif-hash` header against
   * your own secret hash. It proves only that the sender knows a shared secret; nothing
   * binds it to the payload, so there is no integrity and no replay protection.
   */
  flutterwaveV3: {
    kind: "shared-secret",
    header: "verif-hash",
    signs: "raw-body",
    strength: "shared-secret",
  },
  /**
   * Fincra: HMAC-SHA512 hex, keyed with the SEPARATE webhook secret key rather than the
   * API secret, over the `{event, data}` object.
   */
  fincra: {
    kind: "hmac-hex",
    header: "signature",
    algorithm: "SHA-512",
    signs: "raw-body",
    strength: "full-body",
  },
  /**
   * Korapay: HMAC-SHA256 hex over the `data` object ONLY. The `event` field sits
   * outside the signed region and is therefore unauthenticated.
   */
  korapay: {
    kind: "hmac-hex",
    header: "x-korapay-signature",
    algorithm: "SHA-256",
    signs: { jsonPath: ["data"] },
    strength: "partial-body",
  },
  /** Anchor: HMAC-SHA1, base64 of the hex digest, per its own code samples. */
  anchor: {
    kind: "hmac-base64-of-hex",
    header: "x-anchor-signature",
    algorithm: "SHA-1",
    signs: "raw-body",
    strength: "full-body",
  },
  /** Squad: header documented, algorithm and key are NOT. Must not be guessed. */
  squad: {
    kind: "undocumented",
    header: "x-squad-encrypted-body",
    signs: "raw-body",
    strength: "unverified",
  },
  /** Monnify: its OpenAPI spec documents no webhooks at all. */
  monnify: {
    kind: "undocumented",
    header: "monnify-signature",
    signs: "raw-body",
    strength: "unverified",
  },
} as const satisfies Record<string, SignatureScheme>;
