/**
 * Turning Paystack's payloads into naija-pay's.
 *
 * Kept separate from the client so it can be tested against recorded fixtures with no
 * HTTP at all, and so the mapping decisions are reviewable in one place.
 *
 * Every normalised object keeps `raw`, so nothing Paystack returns is ever lost.
 */

import { matchInstitution, mergerWarningFor } from "../../core/banks.ts";
import type { Channel } from "../../core/capabilities.ts";
import { type Money, money } from "../../core/money.ts";
import { CHANNEL_FROM_PAYSTACK, PAYSTACK_PROVIDER_NAME } from "./capabilities.ts";

export type TransactionStatus = "pending" | "successful" | "failed" | "abandoned" | "reversed";

/**
 * Paystack's transaction statuses, mapped onto ours.
 *
 * `ongoing`, `processing` and `queued` are all "not finished yet" from an application's
 * point of view, so they collapse to `pending`. An unrecognised status also becomes
 * `pending` rather than being guessed at as successful — the safe direction, since
 * `pending` means "do not give value yet".
 */
const STATUS_MAP: Record<string, TransactionStatus> = {
  success: "successful",
  failed: "failed",
  abandoned: "abandoned",
  reversed: "reversed",
  pending: "pending",
  ongoing: "pending",
  processing: "pending",
  queued: "pending",
};

export function normaliseStatus(paystackStatus: unknown): TransactionStatus {
  if (typeof paystackStatus !== "string") return "pending";
  return STATUS_MAP[paystackStatus.toLowerCase()] ?? "pending";
}

/**
 * Paystack's transfer statuses.
 *
 * `otp` is the one that matters: it means the transfer is waiting for a human to enter
 * a code sent to the business phone, so it is emphatically not successful. It maps to
 * `pending`, and the adapter surfaces a note alongside it.
 */
const TRANSFER_STATUS_MAP: Record<string, TransactionStatus> = {
  success: "successful",
  failed: "failed",
  reversed: "reversed",
  pending: "pending",
  otp: "pending",
  abandoned: "abandoned",
};

export function normaliseTransferStatus(paystackStatus: unknown): TransactionStatus {
  if (typeof paystackStatus !== "string") return "pending";
  return TRANSFER_STATUS_MAP[paystackStatus.toLowerCase()] ?? "pending";
}

export function normaliseChannel(paystackChannel: unknown): Channel | null {
  if (typeof paystackChannel !== "string") return null;
  return CHANNEL_FROM_PAYSTACK[paystackChannel] ?? null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function asDate(value: unknown): Date | null {
  if (typeof value !== "string" || value === "") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Paystack returns amounts as integers in the currency subunit, which is what we want.
 * It is still validated through `money()` rather than trusted, because a float arriving
 * here would be a silent corruption.
 */
function asMoney(value: unknown, currency: unknown): Money | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return null;
  const code = typeof currency === "string" && currency !== "" ? currency : "NGN";
  return money(value, code as Money["currency"]);
}

export interface CardAuthorization {
  readonly code: string;
  readonly last4: string | null;
  readonly brand: string | null;
  readonly bank: string | null;
  readonly reusable: boolean;
  /** Paystack's card fingerprint, for recognising the same card again. */
  readonly signature: string | null;
}

export interface Customer {
  readonly email: string | null;
  readonly name: string | null;
  readonly phone: string | null;
  readonly providerCustomerCode: string | null;
}

export interface Transaction {
  readonly reference: string;
  readonly providerReference: string;
  readonly status: TransactionStatus;
  readonly amount: Money | null;
  readonly amountPaid: Money | null;
  readonly fees: Money | null;
  readonly channel: Channel | null;
  readonly paidAt: Date | null;
  readonly createdAt: Date | null;
  readonly customer: Customer | null;
  readonly authorization: CardAuthorization | null;
  readonly provider: string;
  readonly raw: unknown;
}

export function toTransaction(data: unknown): Transaction {
  const bag = asRecord(data);
  const currency = bag.currency;
  const customerBag = asRecord(bag.customer);
  const authBag = asRecord(bag.authorization);

  const first = asString(customerBag.first_name);
  const last = asString(customerBag.last_name);
  const name = [first, last].filter(Boolean).join(" ") || null;

  return {
    reference: asString(bag.reference) ?? "",
    providerReference: String(bag.id ?? asString(bag.reference) ?? ""),
    status: normaliseStatus(bag.status),
    // `requested_amount` is what was asked for; `amount` is what was actually paid.
    // Paystack returns both, and conflating them hides partial and over payments.
    amount: asMoney(bag.requested_amount, currency) ?? asMoney(bag.amount, currency),
    amountPaid: asMoney(bag.amount, currency),
    fees: asMoney(bag.fees, currency),
    channel: normaliseChannel(bag.channel),
    paidAt: asDate(bag.paid_at ?? bag.paidAt),
    createdAt: asDate(bag.created_at ?? bag.createdAt),
    customer: {
      email: asString(customerBag.email) ?? null,
      name,
      phone: asString(customerBag.phone) ?? null,
      providerCustomerCode: asString(customerBag.customer_code) ?? null,
    },
    authorization: asString(authBag.authorization_code)
      ? {
          code: asString(authBag.authorization_code) as string,
          last4: asString(authBag.last4) ?? null,
          brand: asString(authBag.brand) ?? null,
          bank: asString(authBag.bank) ?? null,
          reusable: authBag.reusable === true,
          signature: asString(authBag.signature) ?? null,
        }
      : null,
    provider: PAYSTACK_PROVIDER_NAME,
    raw: data,
  };
}

export interface BankAccount {
  readonly accountNumber: string;
  readonly accountName: string;
  readonly bankName: string | null;
  /** Paystack's own code, authoritative for calling Paystack. Never substituted. */
  readonly bankCode: string | null;
  /** Paystack's bank slug, e.g. "titan-paystack", kept for round-tripping. */
  readonly bankSlug: string | null;
  readonly provider: string;
  /** Enrichment from naija-data; null when no institution could be matched. */
  readonly institution: {
    readonly id: string;
    readonly name: string;
    readonly type: string;
    readonly nipCode: string | null;
    readonly cbnCode: string | null;
    readonly status: string;
    readonly mergedInto: string | null;
    readonly unverifiedCodes: readonly string[];
    readonly matchedBy: string;
  } | null;
  /** Present when the matched institution has been merged into another. */
  readonly mergerWarning: string | null;
}

/** Attach naija-data enrichment to a bank account, without changing its code. */
export function enrich(account: {
  accountNumber: string;
  accountName: string;
  bankName?: string | null;
  bankCode?: string | null;
  bankSlug?: string | null;
}): BankAccount {
  const match = matchInstitution({
    ...(account.bankCode ? { code: account.bankCode } : {}),
    ...(account.bankName ? { name: account.bankName } : {}),
  });
  const warning = match ? mergerWarningFor(match.institution) : undefined;

  return {
    accountNumber: account.accountNumber,
    accountName: account.accountName,
    bankName: account.bankName ?? null,
    bankCode: account.bankCode ?? null,
    bankSlug: account.bankSlug ?? null,
    provider: PAYSTACK_PROVIDER_NAME,
    institution: match
      ? {
          id: match.institution.id,
          name: match.institution.name,
          type: match.institution.type,
          nipCode: match.institution.nipCode ?? null,
          cbnCode: match.institution.cbnCode ?? null,
          status: match.institution.status,
          mergedInto: match.institution.mergedInto ?? null,
          unverifiedCodes: match.institution.unverified ?? [],
          matchedBy: match.matchedBy,
        }
      : null,
    mergerWarning: warning?.message ?? null,
  };
}

export interface VirtualAccount {
  readonly reference: string;
  readonly accounts: readonly BankAccount[];
  readonly kind: "static" | "dynamic";
  readonly status: "active" | "inactive";
  readonly customer: Customer | null;
  readonly kycStatus: "pending" | "verified" | "failed" | "not_required";
  readonly provider: string;
  readonly raw: unknown;
}

export function toVirtualAccount(data: unknown): VirtualAccount {
  const bag = asRecord(data);
  const bankBag = asRecord(bag.bank);
  const customerBag = asRecord(bag.customer);
  const assignment = asRecord(bag.assignment);

  const first = asString(customerBag.first_name);
  const last = asString(customerBag.last_name);

  return {
    reference: String(bag.id ?? ""),
    accounts: [
      enrich({
        accountNumber: asString(bag.account_number) ?? "",
        accountName: asString(bag.account_name) ?? "",
        bankName: asString(bankBag.name) ?? null,
        bankSlug: asString(bankBag.slug) ?? null,
      }),
    ],
    kind: "static",
    status: bag.active === false ? "inactive" : "active",
    customer: {
      email: asString(customerBag.email) ?? null,
      name: [first, last].filter(Boolean).join(" ") || null,
      phone: asString(customerBag.phone) ?? null,
      providerCustomerCode: asString(customerBag.customer_code) ?? null,
    },
    // Paystack reports identification asynchronously via customeridentification.*
    // events, so a freshly created account is pending rather than verified. Claiming
    // otherwise would let an application give value on an unverified identity.
    kycStatus: assignment.expired === true ? "failed" : "pending",
    provider: PAYSTACK_PROVIDER_NAME,
    raw: data,
  };
}

export interface Payout {
  readonly reference: string;
  readonly providerReference: string;
  readonly status: TransactionStatus;
  readonly amount: Money | null;
  /**
   * Paystack's NUMERIC recipient id from the transfer response — not the `RCP_` code,
   * which only appears when the recipient is created. Stringified so the two languages
   * agree, since JSON numbers and strings normalise differently otherwise.
   */
  readonly recipientId: string | null;
  /** True when Paystack is waiting for an OTP that a human must supply. */
  readonly awaitingOtp: boolean;
  readonly provider: string;
  readonly raw: unknown;
}

export function toPayout(data: unknown): Payout {
  const bag = asRecord(data);
  const rawStatus = asString(bag.status)?.toLowerCase();

  return {
    reference: asString(bag.reference) ?? "",
    providerReference: asString(bag.transfer_code) ?? String(bag.id ?? ""),
    status: normaliseTransferStatus(bag.status),
    amount: asMoney(bag.amount, bag.currency),
    recipientId:
      typeof bag.recipient === "string" || typeof bag.recipient === "number"
        ? String(bag.recipient)
        : null,
    awaitingOtp: rawStatus === "otp",
    provider: PAYSTACK_PROVIDER_NAME,
    raw: data,
  };
}

export interface Refund {
  readonly providerReference: string;
  readonly transactionReference: string | null;
  readonly status: "pending" | "processing" | "processed" | "failed";
  readonly amount: Money | null;
  readonly provider: string;
  readonly raw: unknown;
}

const REFUND_STATUS_MAP: Record<string, Refund["status"]> = {
  pending: "pending",
  processing: "processing",
  processed: "processed",
  failed: "failed",
  // Paystack's "needs-attention" refunds require bank details before they can proceed.
  "needs-attention": "failed",
};

export function toRefund(data: unknown): Refund {
  const bag = asRecord(data);
  const transactionBag = asRecord(bag.transaction);
  const status = asString(bag.status)?.toLowerCase() ?? "pending";

  return {
    providerReference: String(bag.id ?? ""),
    transactionReference: asString(transactionBag.reference) ?? null,
    status: REFUND_STATUS_MAP[status] ?? "pending",
    amount: asMoney(bag.amount, bag.currency),
    provider: PAYSTACK_PROVIDER_NAME,
    raw: data,
  };
}

export interface SplitAccount {
  readonly code: string;
  readonly businessName: string | null;
  readonly settlementAccount: BankAccount | null;
  readonly percentageCharge: number | null;
  readonly verified: boolean;
  readonly provider: string;
  readonly raw: unknown;
}

export function toSplitAccount(data: unknown): SplitAccount {
  const bag = asRecord(data);
  return {
    code: asString(bag.subaccount_code) ?? "",
    businessName: asString(bag.business_name) ?? null,
    settlementAccount: asString(bag.account_number)
      ? enrich({
          accountNumber: asString(bag.account_number) as string,
          accountName: asString(bag.account_name) ?? "",
          bankName: asString(bag.settlement_bank) ?? null,
        })
      : null,
    percentageCharge: typeof bag.percentage_charge === "number" ? bag.percentage_charge : null,
    verified: bag.is_verified === true,
    provider: PAYSTACK_PROVIDER_NAME,
    raw: data,
  };
}

export interface Split {
  readonly code: string;
  readonly name: string | null;
  readonly type: "percentage" | "flat";
  readonly currency: string | null;
  readonly parties: readonly { readonly account: string; readonly share: number }[];
  readonly provider: string;
  readonly raw: unknown;
}

export function toSplit(data: unknown): Split {
  const bag = asRecord(data);
  const subaccounts = Array.isArray(bag.subaccounts) ? bag.subaccounts : [];

  return {
    code: asString(bag.split_code) ?? "",
    name: asString(bag.name) ?? null,
    type: asString(bag.type) === "flat" ? "flat" : "percentage",
    currency: asString(bag.currency) ?? null,
    parties: subaccounts.map((entry) => {
      const row = asRecord(entry);
      const inner = asRecord(row.subaccount);
      return {
        account: asString(inner.subaccount_code) ?? asString(row.subaccount) ?? "",
        share: typeof row.share === "number" ? row.share : 0,
      };
    }),
    provider: PAYSTACK_PROVIDER_NAME,
    raw: data,
  };
}
