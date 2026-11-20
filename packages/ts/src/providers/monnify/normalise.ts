/**
 * Turning Monnify's payloads into naija-pay's.
 *
 * Kept separate from the client so it can be tested against recorded fixtures with no
 * HTTP at all, and so the mapping decisions are reviewable in one place. Every
 * normalised object keeps `raw`, so nothing Monnify returns is ever lost.
 *
 * Three things to understand before reading further.
 *
 * 1. **Decimals on the wire, and sometimes decimals in strings.** Monnify sends and
 *    accepts amounts as decimals in major units — `100.0` means one hundred naira — and
 *    on a verify response it sends them as JSON *strings*: `"amountPaid": "100.00"`.
 *    Both go through `asMoney`, which converts via `fromMajor` so the conversion is
 *    checked rather than multiplied by 100 and hoped for.
 * 2. **Dates are not ISO 8601.** `paidOn` is `"25/07/2022 11:20:20 AM"` —
 *    day-first, with a 12-hour clock and no timezone. `new Date(...)` on that returns
 *    either an Invalid Date or, worse on some runtimes, July the 25th read as the 7th
 *    of the 25th month. It is parsed explicitly below.
 * 3. **The collection status enum is not published.** The spec shows `PAID` and
 *    `SUCCESSFUL` and documents the transfer states in prose, but it never lists every
 *    collection status. Anything unrecognised therefore maps to `pending`, which is the
 *    safe direction: `pending` means do not give value yet.
 */

import { matchInstitution, mergerWarningFor } from "../../core/banks.ts";
import type { Channel } from "../../core/capabilities.ts";
import { fromMajor, type Money, MoneyError } from "../../core/money.ts";
import { CHANNEL_FROM_MONNIFY, MONNIFY_PROVIDER_NAME } from "./capabilities.ts";

export type TransactionStatus = "pending" | "successful" | "failed" | "abandoned" | "reversed";

/**
 * Monnify's collection statuses, mapped onto ours.
 *
 * `PAID` is Monnify's word for a completed collection; `SUCCESSFUL` appears in the
 * transaction-search sample for the same thing. `OVERPAID` and `PARTIALLY_PAID` are not
 * in the spec's examples but are Monnify's documented inflow variances, and both are
 * mapped deliberately:
 *
 * - `OVERPAID` is `successful` — the money arrived, and more of it than expected. The
 *   variance is a business decision, which `core/events.ts` models with
 *   `classifyInflow`; it is not a reason to withhold the fact that payment succeeded.
 * - `PARTIALLY_PAID` is `pending`, because the amount asked for has not been paid.
 *   Reporting it as successful would be the single most expensive mistake this file
 *   could make.
 */
const STATUS_MAP: Record<string, TransactionStatus> = {
  paid: "successful",
  successful: "successful",
  success: "successful",
  overpaid: "successful",
  partially_paid: "pending",
  pending: "pending",
  failed: "failed",
  cancelled: "abandoned",
  expired: "abandoned",
  abandoned: "abandoned",
  reversed: "reversed",
};

export function normaliseStatus(monnifyStatus: unknown): TransactionStatus {
  if (typeof monnifyStatus !== "string") return "pending";
  return STATUS_MAP[monnifyStatus.trim().toLowerCase()] ?? "pending";
}

/**
 * Monnify's transfer statuses, which the spec does document, and which contain the
 * trap this adapter most needs to absorb.
 *
 * The documented states are `PENDING`, `SUCCESS`, `FAILED`, `REVERSED`,
 * `PENDING_AUTHORIZATION` and `OTP_EMAIL_DISPATCH_FAILED`.
 *
 * `PENDING_AUTHORIZATION` means **no money has moved and none will** until an OTP is
 * submitted — the same trap Paystack's transfer OTP produced, which the Paystack
 * sandbox run caught. It maps to `pending`, and `toPayout` sets `awaitingOtp` so a
 * caller can act on it rather than waiting for a webhook that will never arrive.
 *
 * `OTP_EMAIL_DISPATCH_FAILED` is stranger: the transfer is stuck because Monnify could
 * not even send the OTP. Also `pending`, also `awaitingOtp`, because resending the OTP
 * is exactly what resolves it.
 */
const TRANSFER_STATUS_MAP: Record<string, TransactionStatus> = {
  pending: "pending",
  pending_authorization: "pending",
  otp_email_dispatch_failed: "pending",
  success: "successful",
  successful: "successful",
  failed: "failed",
  reversed: "reversed",
  cancelled: "abandoned",
  expired: "abandoned",
};

export function normaliseTransferStatus(monnifyStatus: unknown): TransactionStatus {
  if (typeof monnifyStatus !== "string") return "pending";
  return TRANSFER_STATUS_MAP[monnifyStatus.trim().toLowerCase()] ?? "pending";
}

export function normaliseChannel(monnifyChannel: unknown): Channel | null {
  if (typeof monnifyChannel !== "string") return null;
  return CHANNEL_FROM_MONNIFY[monnifyChannel.trim().toUpperCase()] ?? null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim() !== "") return value;
  if (typeof value === "number") return String(value);
  return undefined;
}

/**
 * Monnify's own date format, parsed explicitly.
 *
 * `"25/07/2022 11:20:20 AM"` — `dd/MM/yyyy hh:mm:ss a`. Handing that to `new Date()`
 * is how 25 July becomes an Invalid Date, so it is matched instead. ISO 8601 also
 * appears, in `createdOn` and in the transaction-search sample, so both are accepted
 * and anything else returns null rather than a wrong instant.
 *
 * The parsed value is treated as **UTC**. Monnify sends no timezone, and its timestamps
 * are West Africa Time (UTC+1), so this is an hour out — but it is an hour out
 * *consistently and knowably*, where guessing the host's local zone would be anywhere
 * from eleven hours out depending on who deployed it. `raw` keeps Monnify's own string
 * for anyone who needs to be exact, and the sandbox harness asks Monnify which zone it
 * means.
 */
const MONNIFY_DATE = /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})\s*([AaPp])\.?[Mm]\.?$/;

/**
 * An ISO-ish stamp with **no timezone**, which Monnify also sends.
 *
 * `createdOn` on a reserved account is `"2024-11-25 07:35:17.566"` — a space instead of
 * a T, milliseconds, and no offset. That shape is a genuine cross-language hazard:
 * JavaScript's `Date` reads a zoneless date-time as **local** time, while Python's
 * `fromisoformat` returns a **naive** datetime. The same input would then mean different
 * instants in the two packages, and a parity test is the only thing that would ever
 * notice. Both languages therefore pin it to UTC explicitly, matching the dd/MM form
 * above.
 */
const ZONELESS_ISO = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?$/;

export function parseMonnifyDate(value: unknown): Date | null {
  const text = asString(value);
  if (text === undefined) return null;

  const match = MONNIFY_DATE.exec(text.trim());
  if (match) {
    const [, day, month, year, rawHour, minute, second, meridiem] = match as unknown as string[];
    let hour = Number(rawHour);
    const isPm = (meridiem ?? "").toLowerCase() === "p";
    // 12 AM is hour 0 and 12 PM is hour 12; both of those get this wrong if you only
    // add twelve for PM.
    if (isPm && hour !== 12) hour += 12;
    if (!isPm && hour === 12) hour = 0;
    if (hour > 23) return null;

    const stamp = Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      hour,
      Number(minute),
      Number(second),
    );
    const parsed = new Date(stamp);
    // Date.UTC rolls 31/02 forward into March rather than rejecting it, so the parse is
    // confirmed by reading the components back.
    if (parsed.getUTCDate() !== Number(day) || parsed.getUTCMonth() !== Number(month) - 1) {
      return null;
    }
    return parsed;
  }

  const trimmed = text.trim();
  // A zoneless stamp is read as UTC, not as the host's local time: see ZONELESS_ISO.
  const iso = new Date(ZONELESS_ISO.test(trimmed) ? `${trimmed.replace(" ", "T")}Z` : trimmed);
  return Number.isNaN(iso.getTime()) ? null : iso;
}

/**
 * A Monnify amount — a decimal in major units, as a number or a string — as integer
 * minor units.
 *
 * Returns null rather than throwing on a value that is absent, negative, or carries
 * more precision than the currency has. A normaliser is reading somebody else's payload
 * and must not take the process down; the adapter surfaces `raw` alongside, so nothing
 * is hidden.
 */
export function asMoney(value: unknown, currency: unknown = "NGN"): Money | null {
  let major: number;
  if (typeof value === "number") {
    major = value;
  } else if (typeof value === "string" && value.trim() !== "") {
    major = Number(value);
  } else {
    return null;
  }
  if (!Number.isFinite(major) || major < 0) return null;

  const code = (asString(currency) ?? "NGN").toUpperCase();
  try {
    return fromMajor(major, code as Money["currency"]);
  } catch (error) {
    if (error instanceof MoneyError) return null;
    throw error;
  }
}

export interface Customer {
  readonly email: string | null;
  readonly name: string | null;
  readonly phone: string | null;
  readonly providerCustomerCode: string | null;
}

function toCustomer(value: unknown): Customer | null {
  const bag = asRecord(value);
  const email = asString(bag.email) ?? asString(bag.customerEmail);
  const name = asString(bag.name) ?? asString(bag.customerName);
  const phone = asString(bag.phoneNumber) ?? asString(bag.customerPhoneNumber);
  if (!email && !name && !phone) return null;
  return {
    email: email ?? null,
    name: name ?? null,
    phone: phone ?? null,
    // Monnify has no customer object and no customer code; the account reference is
    // the nearest thing and belongs to a reserved account, not to a person.
    providerCustomerCode: null,
  };
}

export interface CardAuthorization {
  /**
   * Monnify's reusable card token.
   *
   * Present only when the card supports tokenisation and the merchant has it enabled;
   * `supportsTokenization` and `reusable` both appear on the verify response and are
   * frequently false.
   */
  readonly code: string;
  readonly last4: string | null;
  readonly brand: string | null;
  readonly bank: string | null;
  readonly reusable: boolean;
  /** Monnify publishes no card fingerprint, so this is always null. Stated, not hidden. */
  readonly signature: string | null;
}

function toAuthorization(value: unknown): CardAuthorization | null {
  const bag = asRecord(value);
  const token = asString(bag.cardToken);
  if (!token) return null;
  return {
    code: token,
    last4: asString(bag.last4) ?? null,
    brand: asString(bag.cardType) ?? null,
    bank: asString(bag.bankName) ?? null,
    reusable: bag.reusable === true,
    signature: null,
  };
}

export interface Transaction {
  /** Your own `paymentReference`. */
  readonly reference: string;
  /** Monnify's `transactionReference`, e.g. `MNFY|67|20220725111957|000283`. */
  readonly providerReference: string;
  readonly status: TransactionStatus;
  /** What the customer was asked for — Monnify's `totalPayable`. */
  readonly amount: Money | null;
  /** What actually arrived — Monnify's `amountPaid`. Differs on an under- or overpayment. */
  readonly amountPaid: Money | null;
  readonly fees: Money | null;
  /**
   * What reaches your Monnify balance after fees — `settlementAmount`. Paystack has no
   * equivalent on a verify response, so this is Monnify- and Flutterwave-shaped.
   */
  readonly amountSettled: Money | null;
  readonly channel: Channel | null;
  readonly paidAt: Date | null;
  readonly createdAt: Date | null;
  readonly customer: Customer | null;
  readonly authorization: CardAuthorization | null;
  /** The account the money arrived in, when it came by transfer. */
  readonly destinationAccount: BankAccount | null;
  /**
   * Who sent the transfer, when Monnify could tell.
   *
   * Monnify is unusual in reporting the payer's own account for a bank transfer, which
   * is what makes `restrictPaymentSource` on a reserved account possible.
   */
  readonly sourceAccount: BankAccount | null;
  readonly provider: string;
  readonly raw: unknown;
}

export function toTransaction(data: unknown): Transaction {
  const bag = asRecord(data);
  const currency = asString(bag.currency) ?? asString(bag.currencyCode) ?? "NGN";

  const destination = asRecord(bag.destinationAccountInformation);
  const source = asRecord(bag.paymentSourceInformation);
  // `paymentSourceInformation` is an array on a webhook and an object on a verify
  // response. Monnify is inconsistent here, and both shapes appear in its own samples.
  const sourceEntry = Array.isArray(bag.paymentSourceInformation)
    ? asRecord((bag.paymentSourceInformation as unknown[])[0])
    : source;

  return {
    reference: asString(bag.paymentReference) ?? "",
    providerReference: asString(bag.transactionReference) ?? "",
    status: normaliseStatus(bag.paymentStatus),
    amount: asMoney(bag.totalPayable ?? bag.amount, currency),
    amountPaid: asMoney(bag.amountPaid, currency),
    fees: asMoney(bag.fee, currency),
    amountSettled: asMoney(bag.settlementAmount, currency),
    channel: normaliseChannel(bag.paymentMethod),
    paidAt: parseMonnifyDate(bag.paidOn ?? bag.completedOn),
    createdAt: parseMonnifyDate(bag.createdOn ?? bag.transactionDate),
    customer: toCustomer(bag.customer ?? bag.customerDTO ?? bag),
    authorization: toAuthorization(bag.cardDetails),
    destinationAccount: toAccountOrNull(destination, {
      accountNumber: asString(destination.accountNumber),
      accountName: asString(destination.accountName),
      bankName: asString(destination.bankName),
      bankCode: asString(destination.bankCode),
    }),
    sourceAccount: toAccountOrNull(sourceEntry, {
      accountNumber: asString(sourceEntry.accountNumber),
      accountName: asString(sourceEntry.accountName),
      bankName: asString(sourceEntry.bankName),
      bankCode: asString(sourceEntry.bankCode),
    }),
    provider: MONNIFY_PROVIDER_NAME,
    raw: data,
  };
}

export interface BankAccount {
  readonly accountNumber: string;
  readonly accountName: string;
  readonly bankName: string | null;
  /** Monnify's own code, authoritative for calling Monnify. Never substituted. */
  readonly bankCode: string | null;
  /** Monnify has no numeric bank id; kept for shape parity with the other adapters. */
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
    provider: MONNIFY_PROVIDER_NAME,
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

/** Enrich an account only when there is an account number to enrich. */
function toAccountOrNull(
  bag: Record<string, unknown>,
  fields: {
    accountNumber: string | undefined;
    accountName: string | undefined;
    bankName: string | undefined;
    bankCode: string | undefined;
  },
): BankAccount | null {
  if (Object.keys(bag).length === 0 || fields.accountNumber === undefined) return null;
  return enrich({
    accountNumber: fields.accountNumber,
    accountName: fields.accountName ?? "",
    ...(fields.bankName === undefined ? {} : { bankName: fields.bankName }),
    ...(fields.bankCode === undefined ? {} : { bankCode: fields.bankCode }),
  });
}

export interface VirtualAccount {
  /** Your own `accountReference`. */
  readonly reference: string;
  /**
   * Every account reserved for this customer.
   *
   * Monnify is the only Tier 1 provider that can reserve an account at several partner
   * banks at once — `getAllAvailableBanks: true` — so this is a list in practice and
   * not just in shape. The v1 invoice route returns a single account, flattened into
   * the same list here.
   */
  readonly accounts: readonly BankAccount[];
  readonly kind: "static" | "dynamic";
  readonly status: "active" | "inactive";
  readonly customer: Customer | null;
  readonly kycStatus: "pending" | "verified" | "failed" | "not_required";
  /** Monnify's `reservationReference`, which is its own handle for the reservation. */
  readonly reservationReference: string | null;
  readonly contractCode: string | null;
  /**
   * Whether inflows are restricted to named sources.
   *
   * Monnify's documentation says this defaults to **true**, which would be unusual and
   * dangerous: a reserved account created without `allowedPaymentSources` would reject
   * the payments you are waiting for. The sandbox returns **false** when the field is
   * omitted (verified 2026-11-19). Because the two disagree, the adapter always sends
   * the field rather than relying on a default, and this is what Monnify reported back.
   */
  readonly restrictPaymentSource: boolean;
  readonly expiresAt: Date | null;
  readonly provider: string;
  readonly raw: unknown;
}

/**
 * The NUBANs on a reserved account.
 *
 * Two shapes reach this: the v2 route returns an `accounts` list, while the v1 invoice
 * route returns one flat accountNumber/bankName/bankCode. Both come out as the list, and
 * the flat shape is only read when the list gave nothing — an `accounts` entry without an
 * account number is not an account.
 */
function toAccounts(bag: Record<string, unknown>): BankAccount[] {
  const accounts: BankAccount[] = [];
  const listed = Array.isArray(bag.accounts) ? (bag.accounts as unknown[]) : [];
  for (const entry of listed) {
    const account = asRecord(entry);
    const accountNumber = asString(account.accountNumber);
    if (accountNumber === undefined) continue;
    const bankName = asString(account.bankName);
    const bankCode = asString(account.bankCode);
    accounts.push(
      enrich({
        accountNumber,
        accountName: asString(account.accountName) ?? asString(bag.accountName) ?? "",
        ...(bankName === undefined ? {} : { bankName }),
        ...(bankCode === undefined ? {} : { bankCode }),
      }),
    );
  }
  if (accounts.length > 0) return accounts;

  const flatNumber = asString(bag.accountNumber);
  if (flatNumber === undefined) return accounts;
  const bankName = asString(bag.bankName);
  const bankCode = asString(bag.bankCode);
  accounts.push(
    enrich({
      accountNumber: flatNumber,
      accountName: asString(bag.accountName) ?? "",
      ...(bankName === undefined ? {} : { bankName }),
      ...(bankCode === undefined ? {} : { bankCode }),
    }),
  );
  return accounts;
}

export function toVirtualAccount(
  data: unknown,
  context: { reference?: string; kind?: "static" | "dynamic" } = {},
): VirtualAccount {
  const bag = asRecord(data);
  const accounts = toAccounts(bag);

  const status = asString(bag.status)?.toUpperCase();
  const bvn = asString(bag.bvn);

  return {
    reference: context.reference ?? asString(bag.accountReference) ?? "",
    accounts,
    // A reserved account is Monnify's static NUBAN. Its one-off equivalent is a
    // different endpoint, which this adapter does not implement yet.
    kind: context.kind ?? "static",
    status: status === "INACTIVE" || status === "DELETED" ? "inactive" : "active",
    customer: toCustomer(bag),
    // Monnify reports no KYC verdict on a reserved account: it echoes the BVN it was
    // given. `pending` where one was supplied, `not_required` where none was, and never
    // `verified`, which would be a claim Monnify has not made.
    kycStatus: bvn === undefined ? "not_required" : "pending",
    reservationReference: asString(bag.reservationReference) ?? null,
    contractCode: asString(bag.contractCode) ?? null,
    restrictPaymentSource: bag.restrictPaymentSource === true,
    expiresAt: parseMonnifyDate(bag.expiresOn),
    provider: MONNIFY_PROVIDER_NAME,
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
  /** Monnify has no recipient object; a payout names the account every time. */
  readonly recipientId: string | null;
  /**
   * True when Monnify is waiting for an OTP.
   *
   * `PENDING_AUTHORIZATION` and `OTP_EMAIL_DISPATCH_FAILED` both mean no money has
   * moved and none will until `authorizePayout` is called. Two-factor disbursement is
   * on by default on a new Monnify integration, so this is the normal path rather than
   * an edge case.
   */
  readonly awaitingOtp: boolean;
  /** Kept for shape parity with Flutterwave; Monnify has no dashboard approval step. */
  readonly awaitingApproval: boolean;
  readonly createdAt: Date | null;
  readonly provider: string;
  readonly raw: unknown;
}

export function toPayout(data: unknown): Payout {
  const bag = asRecord(data);
  const currency = asString(bag.currency) ?? "NGN";
  const rawStatus = asString(bag.status)?.toUpperCase() ?? "";
  const accountNumber = asString(bag.destinationAccountNumber);
  const bankName = asString(bag.destinationBankName);
  const bankCode = asString(bag.destinationBankCode);

  return {
    reference: asString(bag.reference) ?? "",
    providerReference: asString(bag.transactionReference) ?? asString(bag.reference) ?? "",
    status: normaliseTransferStatus(rawStatus),
    amount: asMoney(bag.amount, currency),
    fee: asMoney(bag.fee ?? bag.totalFee, currency),
    recipient:
      accountNumber === undefined
        ? null
        : enrich({
            accountNumber,
            accountName: asString(bag.destinationAccountName) ?? "",
            ...(bankName === undefined ? {} : { bankName }),
            ...(bankCode === undefined ? {} : { bankCode }),
          }),
    failureReason: asString(bag.transactionDescription) ?? null,
    recipientId: null,
    awaitingOtp: rawStatus === "PENDING_AUTHORIZATION" || rawStatus === "OTP_EMAIL_DISPATCH_FAILED",
    awaitingApproval: false,
    createdAt: parseMonnifyDate(bag.dateCreated ?? bag.createdOn),
    provider: MONNIFY_PROVIDER_NAME,
    raw: data,
  };
}

export interface BulkPayout {
  readonly batchReference: string;
  readonly status: TransactionStatus;
  readonly totalAmount: Money | null;
  readonly totalFee: Money | null;
  readonly transactionCount: number | null;
  readonly successfulCount: number | null;
  readonly failedCount: number | null;
  readonly pendingCount: number | null;
  readonly awaitingOtp: boolean;
  readonly createdAt: Date | null;
  readonly provider: string;
  readonly raw: unknown;
}

function asCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function toBulkPayout(data: unknown): BulkPayout {
  const bag = asRecord(data);
  const rawStatus = asString(bag.batchStatus)?.toUpperCase() ?? "";
  return {
    batchReference: asString(bag.batchReference) ?? "",
    status: normaliseTransferStatus(rawStatus),
    totalAmount: asMoney(bag.totalAmount),
    totalFee: asMoney(bag.totalFee),
    transactionCount: asCount(bag.totalTransactionsCount),
    successfulCount: asCount(bag.successfulCount),
    failedCount: asCount(bag.failedCount),
    pendingCount: asCount(bag.pendingCount),
    awaitingOtp: rawStatus === "PENDING_AUTHORIZATION" || rawStatus === "AWAITING_PROCESSING",
    createdAt: parseMonnifyDate(bag.dateCreated),
    provider: MONNIFY_PROVIDER_NAME,
    raw: data,
  };
}

export interface Refund {
  readonly reference: string;
  readonly providerReference: string;
  readonly transactionReference: string | null;
  readonly status: "pending" | "processing" | "processed" | "failed";
  readonly amount: Money | null;
  readonly destination: BankAccount | null;
  readonly provider: string;
  readonly raw: unknown;
}

/**
 * Monnify's refund statuses.
 *
 * Unrecognised becomes `pending` rather than `processed`: a refund wrongly reported as
 * complete is a customer told their money is on the way when it is not.
 */
const REFUND_STATUS_MAP: Record<string, Refund["status"]> = {
  pending: "pending",
  awaiting_processing: "pending",
  processing: "processing",
  in_progress: "processing",
  completed: "processed",
  processed: "processed",
  successful: "processed",
  success: "processed",
  failed: "failed",
};

export function toRefund(data: unknown): Refund {
  const bag = asRecord(data);
  const status = asString(bag.refundStatus)?.trim().toLowerCase();
  const accountNumber = asString(bag.destinationAccountNumber);
  const bankName = asString(bag.destinationBankName);

  return {
    reference: asString(bag.refundReference) ?? "",
    providerReference: asString(bag.reference) ?? asString(bag.refundReference) ?? "",
    transactionReference: asString(bag.transactionReference) ?? null,
    status: (status === undefined ? undefined : REFUND_STATUS_MAP[status]) ?? "pending",
    amount: asMoney(bag.refundAmount, asString(bag.currencyCode) ?? "NGN"),
    destination:
      accountNumber === undefined
        ? null
        : enrich({
            accountNumber,
            accountName: asString(bag.destinationAccountName) ?? "",
            ...(bankName === undefined ? {} : { bankName }),
          }),
    provider: MONNIFY_PROVIDER_NAME,
    raw: data,
  };
}

export interface SplitAccount {
  /** Monnify's `subAccountCode`, e.g. `MFY_SUB_319452883228`. */
  readonly code: string;
  readonly businessName: string | null;
  readonly settlementAccount: BankAccount | null;
  /**
   * The sub-account's default share, in basis points.
   *
   * Monnify's `defaultSplitPercentage` is a percentage — `20` means 20% — and our API
   * is basis points, so this is multiplied by 100. A fractional percentage that cannot
   * be represented in whole basis points is reported as null rather than rounded, so
   * money is never silently moved between parties.
   */
  readonly defaultShareBasisPoints: number | null;
  readonly email: string | null;
  readonly provider: string;
  readonly raw: unknown;
}

export function toSplitAccount(data: unknown): SplitAccount {
  const bag = asRecord(data);
  const accountNumber = asString(bag.accountNumber);
  const bankName = asString(bag.bankName);
  const bankCode = asString(bag.bankCode);

  const percentage = bag.defaultSplitPercentage;
  let basisPoints: number | null = null;
  if (typeof percentage === "number" && Number.isFinite(percentage)) {
    const scaled = percentage * 100;
    basisPoints = Number.isInteger(scaled) ? scaled : null;
  }

  return {
    code: asString(bag.subAccountCode) ?? "",
    // Monnify names the settlement account's holder, not a business; `accountName` is
    // the nearest honest field.
    businessName: asString(bag.accountName) ?? null,
    settlementAccount:
      accountNumber === undefined
        ? null
        : enrich({
            accountNumber,
            accountName: asString(bag.accountName) ?? "",
            ...(bankName === undefined ? {} : { bankName }),
            ...(bankCode === undefined ? {} : { bankCode }),
          }),
    defaultShareBasisPoints: basisPoints,
    email: asString(bag.email) ?? null,
    provider: MONNIFY_PROVIDER_NAME,
    raw: data,
  };
}

export interface Balance {
  readonly accountNumber: string;
  readonly available: Money | null;
  readonly ledger: Money | null;
  readonly provider: string;
  readonly raw: unknown;
}

export function toBalance(data: unknown, accountNumber: string): Balance {
  const bag = asRecord(data);
  return {
    accountNumber,
    available: asMoney(bag.availableBalance),
    ledger: asMoney(bag.ledgerBalance),
    provider: MONNIFY_PROVIDER_NAME,
    raw: data,
  };
}

export interface Bank {
  readonly name: string;
  readonly code: string;
  /** Monnify is the only Tier 1 provider that publishes USSD templates per bank. */
  readonly ussdTemplate: string | null;
  readonly baseUssdCode: string | null;
  readonly transferUssdTemplate: string | null;
  readonly provider: string;
  readonly raw: unknown;
}

export function toBank(data: unknown): Bank {
  const bag = asRecord(data);
  return {
    name: asString(bag.name) ?? "",
    code: asString(bag.code) ?? "",
    ussdTemplate: asString(bag.ussdTemplate) ?? null,
    baseUssdCode: asString(bag.baseUssdCode) ?? null,
    transferUssdTemplate: asString(bag.transferUssdTemplate) ?? null,
    provider: MONNIFY_PROVIDER_NAME,
    raw: data,
  };
}

/**
 * A Spring `Page`, which is what Monnify returns from every list endpoint.
 *
 * Normalised to the shape the other adapters use, so a caller does not have to know
 * that Monnify's backend is Spring. `last` is kept as `hasMore` inverted, because a
 * boolean named `last` reads as "the last item" rather than "the last page".
 */
export interface Page<T> {
  readonly items: readonly T[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly totalPages: number;
  readonly hasMore: boolean;
  readonly raw: unknown;
}

export function toPage<T>(data: unknown, map: (item: unknown) => T): Page<T> {
  const bag = asRecord(data);
  const content = Array.isArray(bag.content) ? (bag.content as unknown[]) : [];
  const pageable = asRecord(bag.pageable);
  const last = bag.last;

  const page = typeof bag.number === "number" ? bag.number : (asCount(pageable.pageNumber) ?? 0);
  const pageSize = typeof bag.size === "number" ? bag.size : (asCount(pageable.pageSize) ?? 0);

  return {
    items: content.map(map),
    page,
    pageSize,
    total: asCount(bag.totalElements) ?? content.length,
    totalPages: asCount(bag.totalPages) ?? 0,
    // Monnify omits `last` on some list responses, so absence is treated as "no more"
    // rather than looping forever on a paginator that trusts it.
    hasMore: last === false,
    raw: data,
  };
}
