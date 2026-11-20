/**
 * What the Monnify adapter can do.
 *
 * Read from Monnify's current documentation on 2026-11-11: the machine-readable
 * OpenAPI 3.1 document at
 * <https://developers.monnify.com/collection/monnify-collection.yml> (`info.version`
 * 2.0.0), which is the API reference itself rather than a rendering of it, and the
 * webhook guide at <https://developers.monnify.com/docs/webhooks>, which is the one
 * part of the API the spec does not cover.
 *
 * Four things about Monnify shape this declaration.
 *
 * ## 1. Authentication is two steps, not one
 *
 * Every other Tier 1 provider takes a static secret. Monnify takes an API key and a
 * secret key, sends them as HTTP Basic to `POST /api/v1/auth/login`, and returns a
 * Bearer token with an `expiresIn` in seconds. Every other call carries that token.
 * The adapter caches it and refreshes it before expiry; `core/http.ts` already
 * supports this through `authorize`.
 *
 * ## 2. Two features need Monnify's commercial approval
 *
 * The spec says so itself, in the descriptions of the endpoints:
 *
 * - **Transfers (disbursements)** — "only available for merchants who meet the
 *   regulatory requirements for it. Kindly contact sales@monnify.com".
 * - **Sub accounts** and **refunds** — "usage of this API in live environment requires
 *   approval from your relationship manager".
 *
 * Those operations are declared `requiresApproval`, so the generated capability matrix
 * says so and nobody designs around a feature they cannot switch on.
 *
 * ## 3. The webhook signature is real, and the sandbox does not send it
 *
 * Monnify's webhook page documents HMAC-SHA512, hex, over the request body, keyed with
 * the merchant **client secret** — the same secret used to authenticate. We verified
 * that against Monnify's own published sample: the page publishes a client secret, a
 * payload and the expected hash, and `HMAC-SHA512(body, secret)` reproduces it
 * exactly. The fixture pins it in both languages.
 *
 * The page also says, in plain words, that **the `monnify-signature` header is only
 * included on notifications sent in production**. A sandbox delivery carries no
 * signature at all, so this is the one Tier 1 scheme that cannot be confirmed end to
 * end against a sandbox, however much sandbox access you have. Monnify's published
 * vector is the better evidence, and it is what we rely on.
 *
 * ## 4. Monnify's income split is not Paystack's transaction split
 *
 * A reserved (virtual) account carries its own `incomeSplitConfig`, so every inflow to
 * that account is split. Paystack's splits sit on a transaction. Both are modelled, and
 * the account-level one is not pretended to be the other.
 */

import type {
  Channel,
  Operation,
  OperationSupport,
  ProviderCapabilities,
} from "../../core/capabilities.ts";

export const MONNIFY_PROVIDER_NAME = "monnify";

/**
 * Monnify is the first Tier 1 provider with genuinely separate hosts.
 *
 * Paystack and Flutterwave v3 serve test and live from one host, so only the key says
 * which you are in. Monnify's sandbox is a different machine, which means a test key
 * cannot reach live money even if the environment is set wrongly. The key prefix is
 * still checked, because the reverse mistake — a live key pointed at the live host by
 * accident — is the expensive one.
 */
export const MONNIFY_SANDBOX_BASE_URL = "https://sandbox.monnify.com";
export const MONNIFY_LIVE_BASE_URL = "https://api.monnify.com";

/** The token endpoint. Basic in, Bearer out. */
export const MONNIFY_LOGIN_PATH = "/api/v1/auth/login";

/**
 * Monnify's one published webhook source address.
 *
 * Mirrors the Paystack adapter's `isKnownWebhookIp`. Monnify names a single address,
 * and an IP check is a second line of defence, never a replacement for the signature.
 */
export const MONNIFY_WEBHOOK_IPS: readonly string[] = ["35.242.133.146"];

/**
 * Monnify's `paymentMethods` names, which are not ours.
 *
 * An array of upper-case strings, from the spec's own enum:
 * `CARD`, `ACCOUNT_TRANSFER`, `USSD`, `PHONE_NUMBER`.
 */
export const CHANNEL_TO_MONNIFY: Partial<Record<Channel, string>> = {
  card: "CARD",
  bank_transfer: "ACCOUNT_TRANSFER",
  ussd: "USSD",
  // Monnify's PHONE_NUMBER is PayAttitude — paying by phone number rather than card.
  // `wallet` is the nearest thing in our vocabulary; the mapping is recorded here
  // rather than left to a reader to infer.
  wallet: "PHONE_NUMBER",
};

export const CHANNEL_FROM_MONNIFY: Record<string, Channel> = {
  CARD: "card",
  ACCOUNT_TRANSFER: "bank_transfer",
  USSD: "ussd",
  PHONE_NUMBER: "wallet",
  // Observed in the spec's offline-payment sample, which has no channel of ours.
  CASH: "bank_transfer",
};

const SUPPORTED: Partial<Record<Operation, OperationSupport>> = {
  "checkout.create": {
    notes:
      "POST /api/v1/merchant/transactions/init-transaction returns a checkoutUrl. " +
      "Amounts go on the wire as decimals in major units, converted from minor units " +
      "by core/money. contractCode is required and comes from configuration.",
  },
  "transactions.verify": {
    notes:
      "GET /api/v2/transactions/{transactionReference}. Monnify returns amountPaid, " +
      "totalPayable and settlementAmount as STRINGS, and paidOn as " +
      "'dd/MM/yyyy hh:mm:ss a' rather than ISO 8601 — both handled in normalise.ts.",
  },
  "transactions.list": {
    notes: "GET /api/v1/transactions/search, a Spring page: content, totalElements, last.",
  },
  "refunds.create": {
    requiresApproval: true,
    notes:
      "Spec: 'usage of this API in live environment requires approval from your " +
      "relationship manager'. refundReference is yours; refundReason and customerNote " +
      "are both required.",
  },
  "refunds.status": {
    requiresApproval: true,
    notes: "GET /api/v1/refunds/{refundReference} — see the path note in PROVIDERS.md.",
  },

  "virtualAccounts.createStatic": {
    requiredKyc: ["bvn"],
    notes:
      "POST /api/v2/bank-transfer/reserved-accounts. getAllAvailableBanks true reserves " +
      "an account at EVERY partner bank at once and returns them all, which no other " +
      "Tier 1 provider offers. The spec marks bvn required.",
  },
  "virtualAccounts.get": {
    notes: "GET /api/v2/bank-transfer/reserved-accounts/{accountReference}.",
  },
  "virtualAccounts.updateKyc": {
    notes:
      "Two routes, and they are not interchangeable: update-customer-bvn takes a BVN " +
      "alone, while {accountReference}/kyc-info requires BOTH a bvn and a nin.",
  },
  "virtualAccounts.deactivate": {
    notes:
      "DELETE /api/v1/bank-transfer/reserved-accounts/reference/{accountReference}. " +
      "Monnify calls it deallocation and it cannot be undone — there is no reactivate.",
  },
  "virtualAccounts.listInflows": {
    notes:
      "GET /api/v1/bank-transfer/reserved-accounts/transactions, with accountReference " +
      "as a REQUIRED query parameter.",
  },

  "splitAccounts.create": {
    requiresApproval: true,
    notes:
      "POST /api/v1/sub-accounts takes an ARRAY and returns an array, even for one " +
      "sub-account. defaultSplitPercentage is a percentage (20 means 20%); we take " +
      "basis points and convert.",
  },
  "splitAccounts.list": { requiresApproval: true },
  "splitAccounts.update": {
    requiresApproval: true,
    notes: "PUT /api/v1/sub-accounts, with subAccountCode in the body rather than the path.",
  },
  "splitAccounts.deactivate": {
    requiresApproval: true,
    notes: "DELETE /api/v1/sub-accounts/{subAccountCode}.",
  },
  "splits.create": {
    notes:
      "Monnify has no standalone split object: the split is declared on the checkout, " +
      "or on a reserved account, as an incomeSplitConfig. createSplit returns a " +
      "reusable declaration and makes no network call.",
  },
  "splits.update": {
    notes:
      "The only updatable split is a reserved account's: PUT " +
      "/api/v1/bank-transfer/reserved-accounts/update-income-split-config/{ref}, whose " +
      "body is a bare ARRAY, not an object.",
  },

  "payouts.create": {
    requiresApproval: true,
    notes:
      "POST /api/v2/disbursements/single. Returns status PENDING_AUTHORIZATION when " +
      "two-factor is on, which means an OTP must be submitted before any money moves — " +
      "the same trap as Paystack's transfer OTP. sourceAccountNumber is your Monnify " +
      "wallet account number and is required.",
  },
  "payouts.createBulk": {
    requiresApproval: true,
    notes:
      "POST /api/v2/disbursements/batch. onValidationFailure decides whether one bad " +
      "row stops the batch (BREAK) or is skipped (CONTINUE).",
  },
  "payouts.status": {
    requiresApproval: true,
    notes:
      "GET /api/v2/disbursements/single/summary?reference=. Documented states: PENDING, " +
      "SUCCESS, FAILED, REVERSED, PENDING_AUTHORIZATION, OTP_EMAIL_DISPATCH_FAILED.",
  },
  "banks.list": { notes: "GET /api/v1/banks, which also returns USSD templates per bank." },
  "banks.resolveAccount": {
    notes: "GET /api/v2/disbursements/account/validate?accountNumber=&bankCode=.",
  },
  "balance.get": {
    requiresApproval: true,
    notes:
      "GET /api/v2/disbursements/wallet-balance?accountNumber=. Needs the wallet " +
      "account number, so it is configuration, not a bare call.",
  },

  "webhooks.verify": {
    notes:
      "HMAC-SHA512 hex over the raw body, keyed with the client secret. Verified " +
      "against Monnify's own published sample. The header is NOT sent in sandbox, so a " +
      "sandbox delivery can only ever be reported unverified.",
  },
};

/**
 * Operations Monnify supports that this adapter has not implemented yet.
 *
 * Data rather than prose, so the generated matrix shows them as planned instead of
 * silently missing.
 */
export const NOT_YET_IMPLEMENTED: Readonly<Record<string, string>> = {
  "virtualAccounts.createDynamic":
    "Monnify's equivalent is POST /api/v1/merchant/bank-transfer/init-payment, which " +
    "returns a one-off account for a single transaction. Lands in milestone 7 with the " +
    "same shape as Flutterwave's dynamic account.",
  "virtualAccounts.list":
    "Monnify has no route that lists reserved accounts; they are fetched by reference.",
  "splits.list": "No split object exists to list; read the account or checkout that carries it.",
  "splits.settlements":
    "GET /api/v1/settlement-detail and find-by-settlement-reference. Milestone 7.",
  "wallets.open":
    "Monnify's sub-accounts are settlement destinations for splits, not spendable " +
    "customer wallets: they are a bank account you already own, not an account Monnify " +
    "opens and holds a balance in. Declaring them as wallets would promise a balance " +
    "and a statement that do not exist. Monnify's Wallet-as-a-Service product " +
    "(/api/v1/disbursements/wallet) is the real equivalent and lands in milestone 7.",
  "wallets.balance": "Same reason. The WaaS wallet lands in milestone 7.",
  "wallets.statement": "Same reason. /api/v1/disbursements/wallet/transactions, milestone 7.",
  "wallets.transfer": "Same reason.",
  "wallets.onboardCustomer": "Same reason.",
  "wallets.freeze": "Not offered.",
  "wallets.unfreeze": "Not offered.",
  "wallets.close": "Same reason.",
  "plans.create": "Monnify has invoices and paycodes but no subscription plan object.",
  "subscriptions.create": "See plans.create.",
  "charges.chargeAuthorization":
    "POST /api/v1/merchant/cards/charge-card-token. Deferred with the rest of card " +
    "tokenisation, which needs the PCI discussion in DESIGN.md settled first.",
  "mandates.create": "POST /api/v1/direct-debit/mandate/create. Milestone 7.",
  "mandates.status": "GET /api/v1/direct-debit/mandate/debit-status. Milestone 7.",
  "mandates.debit": "POST /api/v1/direct-debit/mandate/debit. Milestone 7.",
  "mandates.cancel":
    "PATCH /api/v1/direct-debit/mandate/cancel-mandate/{mandateCode}. Milestone 7.",
  "identity.verifyBvn":
    "POST /api/v1/vas/bvn-details-match and bvn-account-match. These are match calls " +
    "rather than lookups — you send what you believe and Monnify grades it — so they " +
    "need their own result type. Milestone 7.",
  "identity.verifyNin": "POST /api/v1/vas/nin-details. Milestone 7, with the BVN calls.",
};

export const monnifyCapabilities: ProviderCapabilities = {
  provider: MONNIFY_PROVIDER_NAME,
  operations: SUPPORTED,
  channels: ["card", "bank_transfer", "ussd", "wallet"],
  /**
   * NGN only. The spec takes a `currencyCode` on several calls and names no other
   * currency anywhere, and Monnify is a Nigerian acquirer. Sending anything else
   * fails locally rather than at Monnify.
   */
  currencies: ["NGN"],
  webhookSignature: {
    strength: "full-body",
    header: "monnify-signature",
    algorithm:
      "HMAC-SHA512 over the raw request body, lowercase hex, keyed with the merchant " +
      "client secret (the same secret used for API authentication, not a separate " +
      "webhook key).",
    notes:
      "Monnify's webhook page contradicts itself: its prose gives the formula as " +
      "'SHA-512(client secret key + object of request body)', a plain digest of a " +
      "concatenation, while its security note and all three of its code samples " +
      "(Node, PHP, Java) compute an HMAC. The page also publishes a worked example — " +
      "a client secret, a payload and the expected hash — and HMAC-SHA512(body, " +
      "secret) reproduces that hash exactly while the concatenated digest does not. " +
      "So the samples are right and the prose is stale, and that is settled by " +
      "evidence rather than by preference. A fixture pins the published vector in both " +
      "languages. Separately, and importantly: the header is only sent in production, " +
      "so no amount of sandbox access can confirm this end to end.",
  },
};
