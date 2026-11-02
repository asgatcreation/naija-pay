/**
 * Turning Flutterwave's payloads into naija-pay's.
 *
 * Kept separate from the client so it can be tested against recorded fixtures with no
 * HTTP at all, and so the mapping decisions are reviewable in one place.
 *
 * Every normalised object keeps `raw`, so nothing Flutterwave returns is ever lost.
 *
 * The one thing to understand before reading further: **Flutterwave puts decimals on
 * the wire.** Paystack sends `500000` and means 5,000 naira; Flutterwave sends `5000`
 * and means the same thing, and sends `20000.5` for twenty thousand naira and fifty
 * kobo. Every amount therefore passes through `asMoney` below, which converts through
 * `fromMajor` so the conversion is checked rather than multiplied by 100 and hoped for.
 */

import { matchInstitution, mergerWarningFor } from "../../core/banks.ts";
import type { Channel } from "../../core/capabilities.ts";
import { fromMajor, type Money, MoneyError } from "../../core/money.ts";
import { CHANNEL_FROM_FLUTTERWAVE, FLUTTERWAVE_PROVIDER_NAME } from "./capabilities.ts";

export type TransactionStatus = "pending" | "successful" | "failed" | "abandoned" | "reversed";

/**
 * Flutterwave's transaction statuses, mapped onto ours.
 *
 * An unrecognised status becomes `pending` rather than being guessed at as successful —
 * the safe direction, since `pending` means "do not give value yet".
 */
const STATUS_MAP: Record<string, TransactionStatus> = {
  successful: "successful",
  success: "successful",
  failed: "failed",
  cancelled: "abandoned",
  abandoned: "abandoned",
  reversed: "reversed",
  pending: "pending",
  "pending-validation": "pending",
};

export function normaliseStatus(flutterwaveStatus: unknown): TransactionStatus {
  if (typeof flutterwaveStatus !== "string") return "pending";
  return STATUS_MAP[flutterwaveStatus.toLowerCase()] ?? "pending";
}

/**
 * Flutterwave's transfer statuses, which are upper-case and include a trap.
 *
 * `NEW` is the status every freshly created transfer has, and it means **queued**, not
 * done. The enclosing envelope says `"status": "success"` and `"message": "Transfer
 * Queued Successfully"` at the same time, so reading the envelope instead of
 * `data.status` makes every payout look complete the instant it is accepted. That is
 * the most dangerous misreading of this API, so `NEW` maps to `pending` and the
 * adapter's own tests assert it.
 */
const TRANSFER_STATUS_MAP: Record<string, TransactionStatus> = {
  new: "pending",
  pending: "pending",
  successful: "successful",
  success: "successful",
  failed: "failed",
  cancelled: "abandoned",
  reversed: "reversed",
};

export function normaliseTransferStatus(flutterwaveStatus: unknown): TransactionStatus {
  if (typeof flutterwaveStatus !== "string") return "pending";
  return TRANSFER_STATUS_MAP[flutterwaveStatus.toLowerCase()] ?? "pending";
}

export function normaliseChannel(flutterwaveChannel: unknown): Channel | null {
  if (typeof flutterwaveChannel !== "string") return null;
  return CHANNEL_FROM_FLUTTERWAVE[flutterwaveChannel.toLowerCase()] ?? null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Flutterwave uses the literal string "N/A" where a field does not apply, notably in
 * virtual-account responses (`"amount": "N/A"`, `"expiry_date": "N/A"`). Treating that
 * as a value produces an Invalid Date or a NaN amount, so it is filtered here.
 */
function asPresentString(value: unknown): string | undefined {
  const text = asString(value);
  return text === undefined || text === "N/A" ? undefined : text;
}

function asDate(value: unknown): Date | null {
  const text = asPresentString(value);
  if (text === undefined) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * A Flutterwave amount — a decimal in major units — as integer minor units.
 *
 * Flutterwave sends `amount` as a JSON number (`5000`, `20000.5`) and sometimes as a
 * string. Both are accepted, and both go through `fromMajor`, which rounds the scaled
 * integer and then asserts the round trip, so `3.29` becomes exactly 329 rather than
 * the 328.99999999999994 a plain multiply produces.
 *
 * Returns null rather than throwing on a value that is absent, negative, or carries
 * more precision than the currency has. A normaliser is reading somebody else's
 * payload and must not take the process down; the adapter surfaces `raw` alongside,
 * so nothing is hidden.
 */
function asMoney(value: unknown, currency: unknown): Money | null {
  let major: number;
  if (typeof value === "number") {
    major = value;
  } else {
    const text = asPresentString(value);
    if (text === undefined) return null;
    major = Number(text);
  }
  if (!Number.isFinite(major) || major < 0) return null;

  const code = asString(currency) ?? "NGN";
  try {
    return fromMajor(major, code as Money["currency"]);
  } catch (error) {
    if (error instanceof MoneyError) return null;
    throw error;
  }
}

/**
 * Flutterwave returns `requires_approval` and `is_approved` as integers, not booleans.
 * `0`/`1` from the API, but a boolean would not be surprising in a future version, so
 * both are accepted.
 */
function asFlag(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  return typeof value === "number" && value !== 0;
}

export interface Customer {
  readonly email: string | null;
  readonly name: string | null;
  readonly phone: string | null;
  readonly providerCustomerCode: string | null;
}

function toCustomer(value: unknown): Customer | null {
  const bag = asRecord(value);
  const email = asString(bag.email);
  const name = asString(bag.name) ?? asString(bag.fullname);
  const phone = asString(bag.phone_number) ?? asString(bag.phonenumber);
  const code = bag.id === undefined || bag.id === null ? undefined : String(bag.id);
  if (!email && !name && !phone && !code) return null;
  return {
    email: email ?? null,
    name: name ?? null,
    phone: phone ?? null,
    providerCustomerCode: code ?? null,
  };
}

export interface CardAuthorization {
  /**
   * Flutterwave's reusable card token.
   *
   * Only present on a verify response when the card was tokenised. Unlike Paystack's
   * authorization code it is not returned on every card transaction.
   */
  readonly code: string;
  readonly last4: string | null;
  readonly brand: string | null;
  readonly bank: string | null;
  readonly reusable: boolean;
  /** Flutterwave's device fingerprint. Not a card fingerprint; see the note below. */
  readonly signature: string | null;
}

function toAuthorization(value: unknown, deviceFingerprint: unknown): CardAuthorization | null {
  const bag = asRecord(value);
  const token = asString(bag.token);
  if (!token) return null;
  return {
    code: token,
    last4: asString(bag.last_4digits) ?? null,
    brand: asString(bag.type) ?? null,
    bank: asString(bag.issuer) ?? null,
    reusable: true,
    // Paystack's `signature` identifies the card. Flutterwave has no equivalent, and
    // `device_fingerprint` identifies the browser the payment came from, not the card.
    // It is carried here because it is the nearest field, and named honestly in the
    // doc comment rather than passed off as a card fingerprint.
    signature: asString(deviceFingerprint) ?? null,
  };
}

export interface Transaction {
  readonly reference: string;
  readonly providerReference: string;
  readonly status: TransactionStatus;
  /** What the customer was asked for. */
  readonly amount: Money | null;
  /**
   * What was actually taken from the customer.
   *
   * Flutterwave's `charged_amount` exceeds `amount` whenever the customer bears the
   * transaction fee, and this is the field to reconcile a bank statement against.
   */
  readonly amountPaid: Money | null;
  readonly fees: Money | null;
  /**
   * What reaches your Flutterwave balance after fees — Flutterwave's `amount_settled`.
   * Paystack has no equivalent on a verify response, so this is Flutterwave-specific.
   */
  readonly amountSettled: Money | null;
  readonly channel: Channel | null;
  readonly paidAt: Date | null;
  readonly createdAt: Date | null;
  readonly customer: Customer | null;
  readonly authorization: CardAuthorization | null;
  /** Flutterwave's numeric transaction id, needed to verify or refund. */
  readonly transactionId: string | null;
  readonly provider: string;
  readonly raw: unknown;
}

export function toTransaction(data: unknown): Transaction {
  const bag = asRecord(data);
  const currency = bag.currency;
  const id = bag.id === undefined || bag.id === null ? undefined : String(bag.id);

  return {
    reference: asString(bag.tx_ref) ?? "",
    providerReference: asString(bag.flw_ref) ?? "",
    status: normaliseStatus(bag.status),
    amount: asMoney(bag.amount, currency),
    amountPaid: asMoney(bag.charged_amount, currency),
    fees: asMoney(bag.app_fee, currency),
    amountSettled: asMoney(bag.amount_settled, currency),
    channel: normaliseChannel(bag.payment_type),
    // Flutterwave has no separate paid_at: created_at on a successful transaction is
    // when it was created, which is the closest honest answer, so this is only set
    // once the transaction actually succeeded.
    paidAt: normaliseStatus(bag.status) === "successful" ? asDate(bag.created_at) : null,
    createdAt: asDate(bag.created_at),
    customer: toCustomer(bag.customer),
    authorization: toAuthorization(bag.card, bag.device_fingerprint),
    transactionId: id ?? null,
    provider: FLUTTERWAVE_PROVIDER_NAME,
    raw: data,
  };
}

export interface BankAccount {
  readonly accountNumber: string;
  readonly accountName: string;
  readonly bankName: string | null;
  /** Flutterwave's own code, authoritative for calling Flutterwave. Never substituted. */
  readonly bankCode: string | null;
  /** Flutterwave's numeric bank id from GET /banks, kept for round-tripping. */
  readonly bankId: string | null;
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
  bankId?: string | null;
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
    bankId: account.bankId ?? null,
    provider: FLUTTERWAVE_PROVIDER_NAME,
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
  /** Flutterwave's order_ref, which identifies the account for later lookups. */
  readonly orderReference: string | null;
  readonly expiresAt: Date | null;
  readonly provider: string;
  readonly raw: unknown;
}

/**
 * Normalise a virtual account.
 *
 * Flutterwave answers with `response_code` `"02"` and `response_message`
 * `"Transaction in progress"` — an acknowledgement, not a finished account. The
 * account number is usable, but KYC may still be running, so `kycStatus` is `pending`
 * unless Flutterwave says otherwise. `"00"` is its success code.
 */
export function toVirtualAccount(
  data: unknown,
  context: { reference?: string; kind?: "static" | "dynamic" } = {},
): VirtualAccount {
  const bag = asRecord(data);
  const accountNumber = asPresentString(bag.account_number) ?? "";
  const bankName = asPresentString(bag.bank_name);
  const responseCode = asString(bag.response_code);

  const bankCode = asPresentString(bag.bank_code);
  const accounts = accountNumber
    ? [
        enrich({
          accountNumber,
          // A virtual account has no holder name of its own; `note` carries the
          // narration the payer sees. Left empty rather than inventing one.
          accountName: asPresentString(bag.narration) ?? "",
          ...(bankName === undefined ? {} : { bankName }),
          ...(bankCode === undefined ? {} : { bankCode }),
        }),
      ]
    : [];

  // An expiring account is dynamic. Flutterwave does not echo is_permanent, so the
  // caller's own intent is used when given, and the expiry date is the fallback signal.
  const expiresAt = asDate(bag.expiry_date);
  const kind = context.kind ?? (expiresAt === null ? "static" : "dynamic");

  return {
    reference: context.reference ?? asString(bag.tx_ref) ?? "",
    accounts,
    kind,
    status: asPresentString(bag.status)?.toLowerCase() === "inactive" ? "inactive" : "active",
    customer: toCustomer(bag),
    kycStatus: responseCode === "00" ? "verified" : "pending",
    orderReference: asString(bag.order_ref) ?? null,
    expiresAt,
    provider: FLUTTERWAVE_PROVIDER_NAME,
    raw: data,
  };
}

export interface Payout {
  readonly reference: string;
  readonly providerReference: string;
  readonly status: TransactionStatus;
  readonly amount: Money | null;
  readonly fee: Money | null;
  readonly recipient: BankAccount | null;
  readonly failureReason: string | null;
  /** Flutterwave's numeric transfer id. */
  readonly recipientId: string | null;
  /**
   * Flutterwave has no OTP step on transfers; Paystack does. The field is present so
   * both adapters return the same shape, and it is always false here.
   */
  readonly awaitingOtp: boolean;
  /**
   * True when Flutterwave's `requires_approval` is set and `is_approved` is not: the
   * transfer will not move until a human approves it on the dashboard. The Flutterwave
   * equivalent of Paystack's OTP gate, and reported for the same reason — so nobody
   * mistakes an accepted transfer for a sent one.
   */
  readonly awaitingApproval: boolean;
  readonly provider: string;
  readonly raw: unknown;
}

export function toPayout(data: unknown): Payout {
  const bag = asRecord(data);
  const currency = asString(bag.currency);
  const accountNumber = asString(bag.account_number);
  const requiresApproval = asFlag(bag.requires_approval);
  const isApproved = asFlag(bag.is_approved);
  const bankName = asString(bag.bank_name);
  const bankCode = asString(bag.bank_code);

  return {
    reference: asString(bag.reference) ?? "",
    providerReference: bag.id === undefined || bag.id === null ? "" : String(bag.id),
    status: normaliseTransferStatus(bag.status),
    amount: asMoney(bag.amount, currency),
    fee: asMoney(bag.fee, currency),
    recipient: accountNumber
      ? enrich({
          accountNumber,
          accountName: asString(bag.full_name) ?? "",
          ...(bankName === undefined ? {} : { bankName }),
          ...(bankCode === undefined ? {} : { bankCode }),
        })
      : null,
    failureReason: asString(bag.complete_message) ?? null,
    recipientId: bag.id === undefined || bag.id === null ? null : String(bag.id),
    awaitingOtp: false,
    awaitingApproval: requiresApproval && !isApproved,
    provider: FLUTTERWAVE_PROVIDER_NAME,
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
  completed: "processed",
  successful: "processed",
  processed: "processed",
  pending: "pending",
  processing: "processing",
  failed: "failed",
};

export function toRefund(data: unknown): Refund {
  const bag = asRecord(data);
  const status = asString(bag.status)?.toLowerCase();
  const txId = bag.tx_id === undefined || bag.tx_id === null ? undefined : String(bag.tx_id);

  return {
    providerReference: bag.id === undefined || bag.id === null ? "" : String(bag.id),
    transactionReference: txId ?? asString(bag.flw_ref) ?? null,
    status: (status === undefined ? undefined : REFUND_STATUS_MAP[status]) ?? "pending",
    // A refund response carries no currency; NGN is Flutterwave's default and the
    // adapter passes the transaction's currency in when it knows it.
    amount: asMoney(bag.amount_refunded, bag.currency),
    provider: FLUTTERWAVE_PROVIDER_NAME,
    raw: data,
  };
}

export interface SplitAccount {
  /** Flutterwave's `subaccount_id` (`RS_...`), the value to put on a checkout. */
  readonly code: string;
  readonly businessName: string | null;
  readonly settlementAccount: BankAccount | null;
  /**
   * The subaccount's default share, in basis points, converted from Flutterwave's
   * decimal fraction. `0.09` on the wire becomes 900 here. Null for a flat split,
   * where `flatCharge` carries the amount instead.
   */
  readonly percentageCharge: number | null;
  /** The subaccount's default flat share, in minor units. Null for a percentage split. */
  readonly flatCharge: Money | null;
  readonly verified: boolean;
  readonly provider: string;
  readonly raw: unknown;
}

export function toSplitAccount(data: unknown): SplitAccount {
  const bag = asRecord(data);
  const splitType = asString(bag.split_type)?.toLowerCase();
  const splitValue = typeof bag.split_value === "number" ? bag.split_value : null;
  const isFlat = splitType === "flat";
  const bankName = asString(bag.bank_name);
  const bankCode = asString(bag.account_bank);

  return {
    code: asString(bag.subaccount_id) ?? "",
    businessName: asString(bag.full_name) ?? asString(bag.business_name) ?? null,
    settlementAccount: asString(bag.account_number)
      ? enrich({
          accountNumber: asString(bag.account_number) ?? "",
          accountName: asString(bag.full_name) ?? "",
          ...(bankName === undefined ? {} : { bankName }),
          ...(bankCode === undefined ? {} : { bankCode }),
        })
      : null,
    // Rounded, because the fraction is Flutterwave's and need not land on a whole
    // basis point. Guarded against a nonsensical value above 100%.
    percentageCharge:
      !isFlat && splitValue !== null && splitValue >= 0 && splitValue <= 1
        ? Math.round(splitValue * 10_000)
        : null,
    flatCharge: isFlat ? asMoney(splitValue, "NGN") : null,
    // Flutterwave verifies settlement bank details asynchronously and does not report
    // the outcome on this object, so this is never asserted as true from the payload.
    verified: false,
    provider: FLUTTERWAVE_PROVIDER_NAME,
    raw: data,
  };
}

export interface WalletAccount {
  /** Use this as `debit_subaccount` on a transfer, and to read the balance. */
  readonly reference: string;
  /** Use this as `account_number` for a wallet-to-wallet transfer. */
  readonly barterId: string | null;
  readonly accountName: string | null;
  readonly email: string | null;
  readonly status: "active" | "inactive";
  /** The wallet's own NUBAN, which funds it when money is transferred in. */
  readonly account: BankAccount | null;
  readonly provider: string;
  readonly raw: unknown;
}

export function toWalletAccount(data: unknown): WalletAccount {
  const bag = asRecord(data);
  const nuban = asString(bag.nuban);
  const bankName = asString(bag.bank_name);
  const bankCode = asString(bag.bank_code);

  return {
    reference: asString(bag.account_reference) ?? "",
    barterId: asString(bag.barter_id) ?? null,
    accountName: asString(bag.account_name) ?? null,
    email: asString(bag.email) ?? null,
    status: asString(bag.status)?.toUpperCase() === "ACTIVE" ? "active" : "inactive",
    account: nuban
      ? enrich({
          accountNumber: nuban,
          accountName: asString(bag.account_name) ?? "",
          ...(bankName === undefined ? {} : { bankName }),
          ...(bankCode === undefined ? {} : { bankCode }),
        })
      : null,
    provider: FLUTTERWAVE_PROVIDER_NAME,
    raw: data,
  };
}

export interface WalletBalance {
  readonly reference: string;
  readonly available: Money | null;
  readonly ledger: Money | null;
  readonly provider: string;
  readonly raw: unknown;
}

export function toWalletBalance(data: unknown, reference: string): WalletBalance {
  const bag = asRecord(data);
  const currency = asString(bag.currency) ?? "NGN";

  return {
    reference: asString(bag.account_reference) ?? reference,
    available: asMoney(bag.available_balance, currency),
    ledger: asMoney(bag.ledger_balance, currency),
    provider: FLUTTERWAVE_PROVIDER_NAME,
    raw: data,
  };
}
