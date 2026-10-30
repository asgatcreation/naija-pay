/**
 * What the Paystack adapter can do.
 *
 * Read from <https://paystack.com/docs/api/> on 2026-10-25 and 2026-10-30. Operations
 * Paystack supports but this adapter has not implemented yet are listed at the bottom
 * with the milestone they land in — they are absent from `operations`, so calling one
 * fails locally with a clear message rather than appearing to work.
 */

import type { Channel, Operation, OperationSupport, ProviderCapabilities } from "../../core/capabilities.ts";

export const PAYSTACK_PROVIDER_NAME = "paystack";

/** Single host for both test and live; the key decides which environment you are in. */
export const PAYSTACK_BASE_URL = "https://api.paystack.co";

/**
 * Paystack's channel names, which are not ours.
 *
 * Theirs: card, bank, apple_pay, ussd, qr, mobile_money, bank_transfer, eft,
 * capitec_pay, payattitude. Note `bank` means "pay with bank account", which we call
 * `bank_account`, and there is no Google Pay.
 */
export const CHANNEL_TO_PAYSTACK: Partial<Record<Channel, string>> = {
  card: "card",
  bank_account: "bank",
  bank_transfer: "bank_transfer",
  ussd: "ussd",
  qr: "qr",
  mobile_money: "mobile_money",
  apple_pay: "apple_pay",
};

export const CHANNEL_FROM_PAYSTACK: Record<string, Channel> = {
  card: "card",
  bank: "bank_account",
  bank_transfer: "bank_transfer",
  ussd: "ussd",
  qr: "qr",
  mobile_money: "mobile_money",
  apple_pay: "apple_pay",
};

const SUPPORTED: Partial<Record<Operation, OperationSupport>> = {
  "checkout.create": {},
  "transactions.verify": {},
  "transactions.list": {},
  "refunds.create": {
    notes: "Amount is optional and defaults to the full transaction amount.",
  },
  "refunds.status": {},

  "virtualAccounts.createStatic": {
    requiredKyc: ["bvn"],
    notes:
      "Dedicated Virtual Accounts. Paystack accepts BVN on assignment and reports the " +
      "outcome asynchronously through customeridentification.* events, so a created " +
      "account may still be pending verification.",
  },
  "virtualAccounts.get": {},
  "virtualAccounts.list": {},
  "virtualAccounts.deactivate": {},
  "virtualAccounts.listInflows": {
    notes: "Served from the transaction list filtered to the account's customer.",
  },

  "splitAccounts.create": {
    notes: "Subaccounts. Settlement bank details are verified by Paystack asynchronously.",
  },
  "splitAccounts.list": {},
  "splitAccounts.update": {},
  "splits.create": {
    notes: "Transaction splits. Shares are percentages or flat amounts; we take basis points.",
  },
  "splits.list": {},
  "splits.update": {},

  "payouts.create": {
    notes:
      "Requires a transfer recipient, which this adapter creates for you. If OTP is " +
      "enabled on the integration the transfer returns status 'otp' and cannot complete " +
      "without a human entering the code — see the adapter notes.",
  },
  "payouts.status": {},
  "banks.list": {},
  "banks.resolveAccount": {},
  "balance.get": {},

  "webhooks.verify": {},
};

/**
 * Operations Paystack supports that this adapter has not implemented yet.
 *
 * Kept as data rather than prose so the generated capability matrix can show them as
 * planned instead of silently missing.
 */
export const NOT_YET_IMPLEMENTED: Readonly<Record<string, string>> = {
  "virtualAccounts.createDynamic":
    "Paystack has no per-transaction expiring account; pay-with-transfer on checkout " +
    "covers the same use case. Revisit in milestone 7.",
  "virtualAccounts.updateKyc": "Milestone 7.",
  "splitAccounts.deactivate": "Milestone 7.",
  "splits.settlements": "Milestone 7.",
  "payouts.createBulk": "Milestone 7.",
  "plans.create": "Recurring billing lands in milestone 7.",
  "subscriptions.create": "Recurring billing lands in milestone 7.",
  "charges.chargeAuthorization": "Recurring billing lands in milestone 7.",
  "mandates.create": "Paystack Direct Debit lands in milestone 7.",
  "mandates.status": "Paystack Direct Debit lands in milestone 7.",
  "mandates.debit": "Paystack Direct Debit lands in milestone 7.",
  "mandates.cancel": "Paystack Direct Debit lands in milestone 7.",
  "identity.verifyBvn":
    "Paystack verifies BVN as part of DVA assignment rather than as a standalone call.",
  "identity.verifyNin": "Not offered by Paystack.",
  // wallets.* is absent entirely and deliberately: Paystack has no product that opens a
  // real deposit account holding a balance. See the sub-accounts section of DESIGN.md.
};

export const paystackCapabilities: ProviderCapabilities = {
  provider: PAYSTACK_PROVIDER_NAME,
  operations: SUPPORTED,
  channels: ["card", "bank_account", "bank_transfer", "ussd", "qr", "mobile_money", "apple_pay"],
  currencies: ["NGN", "USD", "GHS", "ZAR", "KES", "XOF"],
  webhookSignature: {
    strength: "full-body",
    header: "x-paystack-signature",
    algorithm: "HMAC-SHA512 hex over the raw body, keyed with the secret key",
    notes:
      "Paystack also publishes a webhook IP allowlist (52.31.139.75, 52.49.173.169, " +
      "52.214.14.220) that is the same for test and live.",
  },
};

/** Paystack's documented webhook source IPs, identical for test and live. */
export const PAYSTACK_WEBHOOK_IPS: readonly string[] = [
  "52.31.139.75",
  "52.49.173.169",
  "52.214.14.220",
];
