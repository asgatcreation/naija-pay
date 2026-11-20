/**
 * What the Fincra adapter can do.
 *
 * Read from Fincra's current documentation on 2026-11-11. Every page is also published
 * as Markdown (append `.md` to its URL) with an `updatedAt` stamp, and most reference
 * pages embed their own OpenAPI document — which is what this adapter was written from,
 * endpoint by endpoint, rather than from the index. The pages and their stamps are
 * recorded per fixture in `fixtures/providers/fincra/`.
 *
 * Four things about Fincra shape this declaration.
 *
 * ## 1. Two hosts, and the host is the environment
 *
 * Sandbox is `sandboxapi.fincra.com` and live is `api.fincra.com`, with separate
 * business IDs and separate keys. Fincra publishes no key prefix convention, so unlike
 * Paystack and Flutterwave there is nothing in the key to check — which is why this
 * adapter will not guess at one. `environment` picks the host and defaults to `test`,
 * and a `live` environment outside production warns loudly.
 *
 * ## 2. The business id is not optional in practice
 *
 * Several endpoints take a `business` field or an `x-business-id` header, and a payout
 * will not go without one. It identifies your business and differs between sandbox and
 * live, so it is configuration. `getBusiness()` fetches it when you do not know it.
 *
 * ## 3. The envelope has two names for the same field
 *
 * Checkout endpoints answer `{"status": true, …}` and payout, bank and wallet endpoints
 * answer `{"success": true, …}`. Both appear in Fincra's own samples, for the same
 * meaning. The adapter accepts either and treats a missing one as success, so a new
 * endpoint spelling it a third way does not break every call.
 *
 * ## 4. The webhook signature is over a re-serialisation
 *
 * Fincra's documented method is HMAC-SHA512, hex, keyed with a **separate webhook
 * secret key**, over `JSON.stringify({event, data})` — a re-serialisation of the parsed
 * payload, not the raw bytes. Their Node sample relies on V8 key ordering and their
 * Python sample pins `separators=(',', ':')`. That is fragile across languages, so this
 * adapter hashes the **raw body first** and falls back to a canonical compact
 * re-serialisation only when the raw body does not match, reporting which path matched.
 * See `verifyWebhook`.
 */

import type {
  Channel,
  Operation,
  OperationSupport,
  ProviderCapabilities,
} from "../../core/capabilities.ts";

export const FINCRA_PROVIDER_NAME = "fincra";

/** Separate hosts, with separate business ids and keys. */
export const FINCRA_SANDBOX_BASE_URL = "https://sandboxapi.fincra.com";
export const FINCRA_LIVE_BASE_URL = "https://api.fincra.com";

/**
 * Fincra's `paymentMethods` names, which are not ours.
 *
 * An array of lower-case strings. `payattitude` is paying by phone number, which we
 * call `wallet` for the same reason as Monnify's `PHONE_NUMBER`.
 */
export const CHANNEL_TO_FINCRA: Partial<Record<Channel, string>> = {
  card: "card",
  bank_transfer: "bank_transfer",
  wallet: "payattitude",
  mobile_money: "mobile_money",
};

export const CHANNEL_FROM_FINCRA: Record<string, Channel> = {
  card: "card",
  bank_transfer: "bank_transfer",
  payattitude: "wallet",
  payAttitude: "wallet",
  mobile_money: "mobile_money",
  eft: "bank_account",
};

/**
 * Bank channels Fincra can issue an NGN virtual account at, with the enabled flag
 * exactly as Fincra publishes it.
 *
 * Two of the nine are **disabled**, which is why bank choice has to be a runtime
 * capability query rather than a hardcoded enum: `createVirtualAccount` refuses a
 * disabled channel locally, with this table as the reason.
 */
export const FINCRA_NGN_VIRTUAL_ACCOUNT_CHANNELS: Readonly<Record<string, boolean>> = {
  globus: true,
  wema: true,
  habari: true,
  sterling: true,
  moniepoint: true,
  uba: true,
  opay: true,
  bold: false,
  providus: false,
};

const SUPPORTED: Partial<Record<Operation, OperationSupport>> = {
  "checkout.create": {
    notes:
      "POST /checkout/payments returns data.link. Amounts go on the wire as decimals in " +
      "major units, converted from minor units by core/money. The response envelope " +
      "uses `status` here and `success` on the payout endpoints.",
  },
  "transactions.verify": {
    notes:
      "GET /checkout/payments/merchant-reference/{reference}, by YOUR reference. The " +
      "x-business-id header is required on this call and on no other checkout call.",
  },
  "refunds.create": {
    notes:
      "POST /collections/refund takes only transReference: Fincra refunds the whole " +
      "collection and will not take an amount, so a partial refund is not possible " +
      "through this API.",
    notYetSandboxVerified: true,
  },
  "refunds.status": { notYetSandboxVerified: true },

  "virtualAccounts.createStatic": {
    requiredKyc: ["bvn"],
    notes:
      "POST /profile/virtual-accounts/requests. BVN is required for NGN. accountType " +
      "individual or corporate, and corporate additionally requires businessName and " +
      "bvnName, which must match the name on the BVN. The request is approved " +
      "instantly for NGN but the response still carries a status, which can be pending.",
    notYetSandboxVerified: true,
  },
  "virtualAccounts.createDynamic": {
    notes:
      "POST /profile/virtual-accounts/transfer — a temporary account with an amount and " +
      "an expiry. NGN only, and Fincra takes the amount as a STRING on this one " +
      "endpoint while every other endpoint takes a number.",
    notYetSandboxVerified: true,
  },
  "virtualAccounts.get": { notYetSandboxVerified: true },
  "virtualAccounts.list": {
    notes: "GET /profile/virtual-accounts, paginated as {results, total}.",
    notYetSandboxVerified: true,
  },
  "virtualAccounts.listInflows": {
    notes: "GET /collections, filtered by virtualAccount and business.",
    notYetSandboxVerified: true,
  },

  "payouts.create": {
    notes:
      "POST /disbursements/payouts. `business` is required. success: true means Fincra " +
      "accepted the request, NOT that the payout settled — data.status is the answer, " +
      "and Fincra's own documentation says so in as many words. A cross-currency payout " +
      "also needs a quoteReference, and quotes expire in 30 seconds.",
    notYetSandboxVerified: true,
  },
  "payouts.status": {
    notes:
      "Two routes: by Fincra's reference, and by your own customerReference. Documented " +
      "payout statuses are processing, failed and successful.",
    notYetSandboxVerified: true,
  },
  "banks.list": {
    notes:
      "GET /core/banks, by country or currency. Returns nibssCode alongside Fincra's " +
      "own code, which is the only Tier 1 provider that publishes the NIP code directly.",
  },
  "banks.resolveAccount": {
    notes:
      "POST /core/accounts/resolve, not a GET. `type` is required and selects the kind " +
      "of identifier: bank_account, nuban, iban, mobile_money or interac_etransfer.",
  },
  "balance.get": {
    notes:
      "GET /wallets?businessID= returns one wallet per currency. Fincra reports " +
      "balances as decimals with up to six places, which is more precision than any " +
      "currency has; core/money refuses to convert an inexact one rather than rounding.",
  },

  "identity.verifyBvn": {
    notes:
      "POST /core/bvn-verification. Returns name, gender, date of birth and a photo as " +
      "base64 — the photo is dropped by this adapter, because storing one has NDPA " +
      "implications nobody should inherit by accident.",
    notYetSandboxVerified: true,
  },

  "webhooks.verify": {
    notes:
      "HMAC-SHA512 hex over the payload, keyed with the SEPARATE webhook secret key. " +
      "Fincra documents the input as a re-serialisation of {event, data}; this adapter " +
      "tries the raw body first and reports which input matched.",
  },
};

/**
 * Operations Fincra supports that this adapter has not implemented yet.
 *
 * Data rather than prose, so the generated matrix shows them as planned instead of
 * silently missing.
 */
export const NOT_YET_IMPLEMENTED: Readonly<Record<string, string>> = {
  "transactions.list":
    "GET /collections lists collections rather than transactions, and the two are not " +
    "the same shape. Served by listVirtualAccountInflows today; a general transaction " +
    "list lands in milestone 7.",
  "virtualAccounts.updateKyc":
    "Fincra has no update route: KYC travels with the account request, and a change " +
    "goes through its RFI (request for information) flow, which is a dashboard " +
    "conversation rather than an endpoint.",
  "virtualAccounts.deactivate":
    "Not published. Fincra's accounts carry isActive and isSuspended but no documented " +
    "route to set either.",
  "splitAccounts.create":
    "Fincra has sub-accounts for multi-entity businesses rather than split settlement, " +
    "and no transaction-level split API. Not a gap in the adapter: the product is a " +
    "different shape, and the capability matrix should say so rather than imply one.",
  "splitAccounts.list": "See splitAccounts.create.",
  "splitAccounts.update": "See splitAccounts.create.",
  "splitAccounts.deactivate": "See splitAccounts.create.",
  "splits.create": "See splitAccounts.create — there is no split object to declare.",
  "splits.update": "See splitAccounts.create.",
  "splits.list": "See splitAccounts.create.",
  "splits.settlements": "GET /profile/business/settlements. Milestone 7.",
  "wallets.open":
    "Fincra's wallets are the business's own balances, one per currency, not accounts " +
    "opened for a customer. balance.get reads them; declaring them as customer wallets " +
    "would promise something Fincra does not offer.",
  "wallets.balance": "Use balance.get, which is what Fincra's wallet endpoints really are.",
  "wallets.statement": "GET /profile/business/balance-history. Milestone 7.",
  "wallets.transfer":
    "POST /disbursements/payouts with paymentDestination fliqpay_wallet moves money to " +
    "another Fincra account. Milestone 7, with the account-to-account route.",
  "wallets.onboardCustomer": "Not offered.",
  "wallets.freeze": "Not offered.",
  "wallets.unfreeze": "Not offered.",
  "wallets.close": "Not offered.",
  "payouts.createBulk": "Fincra publishes no batch payout route; loop over payouts.create.",
  "plans.create": "Fincra has no subscription plan object.",
  "subscriptions.create": "See plans.create.",
  "charges.chargeAuthorization":
    "Fincra's direct charge API can charge a card, which means handling the card " +
    "number. Out of scope by policy: naija-pay never touches raw card data. Hosted " +
    "checkout covers the same ground safely.",
  "mandates.create": "POST /mandates. Direct debit lands in milestone 7.",
  "mandates.status": "Milestone 7.",
  "mandates.debit": "Milestone 7.",
  "mandates.cancel": "Milestone 7.",
  "identity.verifyNin": "Fincra publishes no NIN endpoint.",
};

export const fincraCapabilities: ProviderCapabilities = {
  provider: FINCRA_PROVIDER_NAME,
  operations: SUPPORTED,
  channels: ["card", "bank_transfer", "wallet", "mobile_money"],
  /**
   * The widest currency list in Tier 1, which is Fincra's whole proposition: it is a
   * cross-border provider that happens to do Nigerian collections. Taken from the
   * checkout and virtual-account enums, which agree.
   */
  currencies: ["NGN", "GHS", "KES", "TZS", "UGX", "ZMW", "XAF", "XOF", "USD", "EUR", "GBP", "CAD"],
  webhookSignature: {
    strength: "full-body",
    header: "signature",
    algorithm:
      "HMAC-SHA512 over the payload, lowercase hex, keyed with the separate webhook " +
      "secret key from the dashboard — not the API secret key, and not the public key.",
    notes:
      "Fincra documents the signed input as JSON.stringify of the parsed {event, data} " +
      "object, which is a re-serialisation rather than the raw bytes. Its Node sample " +
      "relies on V8's key ordering and its Python sample pins separators, so the two " +
      "agree only as long as nothing reorders a key. naija-pay therefore verifies " +
      "against the raw body first — which is what a signature should cover, and what " +
      "matches if Fincra signs before serialising once — and falls back to a canonical " +
      "compact re-serialisation of {event, data}. The result says which input matched, " +
      "so a fallback match is visible rather than silent, and that observation is what " +
      "we will take to Fincra.",
  },
};

/**
 * Fincra publishes no webhook IP allowlist.
 *
 * Paystack and Monnify both do, and their adapters offer `isKnownWebhookIp`. Fincra's
 * documentation names no source addresses, so this adapter offers no such method rather
 * than one that always answers false.
 */
export const FINCRA_WEBHOOK_IPS: readonly string[] = [];
