/**
 * Turning Fincra's payloads into naija-pay's.
 *
 * Kept separate from the client so it can be tested against recorded fixtures with no
 * HTTP at all, and so the mapping decisions are reviewable in one place. Every
 * normalised object keeps `raw`, so nothing Fincra returns is ever lost.
 *
 * Three things to understand before reading further.
 *
 * 1. **Decimals on the wire, sometimes with six places.** Fincra's amounts are major
 *    units — `350` is three hundred and fifty naira — and its balances and fees come
 *    back with up to six decimal places (`4145.558824`, `fee: 9090.909091`). No currency
 *    has six decimal places, so `asMoney` returns null for a value that cannot be
 *    represented exactly rather than rounding somebody's money. The exact figure stays
 *    in `raw`.
 * 2. **Statuses are documented, and there are three sets of them.** Fincra publishes a
 *    general table, a payout table and a checkout table. They overlap but are not
 *    identical, and `expired` is real: a charge pending for more than two hours becomes
 *    expired. The maps below are those tables.
 * 3. **The envelope has two names.** `{"status": true}` on checkout, `{"success": true}`
 *    on payouts, banks and wallets. That is handled in the client rather than here.
 */

import { matchInstitution, mergerWarningFor } from "../../core/banks.ts";
import type { Channel } from "../../core/capabilities.ts";
import { fromMajor, type Money, MoneyError } from "../../core/money.ts";
import { CHANNEL_FROM_FINCRA, FINCRA_PROVIDER_NAME } from "./capabilities.ts";

export type TransactionStatus = "pending" | "successful" | "failed" | "abandoned" | "reversed";

/**
 * Fincra's collection and charge statuses, from its published table.
 *
 * `initiated` means the charge exists and nobody has paid yet, so it is `pending`.
 * `expired` is Fincra's word for a charge the customer never completed, which is our
 * `abandoned`. Anything unrecognised becomes `pending`, the safe direction.
 */
const STATUS_MAP: Record<string, TransactionStatus> = {
  initiated: "pending",
  pending: "pending",
  processing: "pending",
  success: "successful",
  successful: "successful",
  failed: "failed",
  expired: "abandoned",
  cancelled: "abandoned",
  abandoned: "abandoned",
  reversed: "reversed",
};

export function normaliseStatus(fincraStatus: unknown): TransactionStatus {
  if (typeof fincraStatus !== "string") return "pending";
  return STATUS_MAP[fincraStatus.trim().toLowerCase()] ?? "pending";
}

/**
 * Fincra's payout statuses, from its own payout table: `processing`, `failed`,
 * `successful`.
 *
 * `processing` is explicitly "in progress and awaiting user authorization", so it maps
 * to `pending` and never to successful. A payout API that answered `success: true` at
 * the HTTP level and `processing` in the body is exactly the trap Flutterwave's `NEW`
 * status sets, and Fincra's documentation warns about it in the same words we would.
 */
const PAYOUT_STATUS_MAP: Record<string, TransactionStatus> = {
  pending: "pending",
  processing: "pending",
  success: "successful",
  successful: "successful",
  failed: "failed",
  cancelled: "abandoned",
  expired: "abandoned",
  reversed: "reversed",
};

export function normalisePayoutStatus(fincraStatus: unknown): TransactionStatus {
  if (typeof fincraStatus !== "string") return "pending";
  return PAYOUT_STATUS_MAP[fincraStatus.trim().toLowerCase()] ?? "pending";
}

export function normaliseChannel(fincraChannel: unknown): Channel | null {
  if (typeof fincraChannel !== "string") return null;
  const key = fincraChannel.trim();
  return CHANNEL_FROM_FINCRA[key] ?? CHANNEL_FROM_FINCRA[key.toLowerCase()] ?? null;
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
 * An ISO-ish stamp with **no timezone**, which Fincra sends on refunds.
 *
 * Most Fincra fields are proper ISO 8601 with a `Z`, but a refund's `initiatedAt` and
 * `completedAt` are `"2023-12-07 17:39:00"`: a space instead of a T, and no offset. That
 * shape is a cross-language hazard — JavaScript reads a zoneless date-time as **local**
 * time while Python's `fromisoformat` returns a **naive** datetime, so the same string
 * would mean different instants in the two packages. Both pin it to UTC explicitly.
 */
const ZONELESS_ISO = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?$/;

function asDate(value: unknown): Date | null {
  const text = asString(value)?.trim();
  if (text === undefined) return null;
  const parsed = new Date(ZONELESS_ISO.test(text) ? `${text.replace(" ", "T")}Z` : text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * A Fincra amount — a decimal in major units — as integer minor units.
 *
 * Returns null rather than throwing on a value that is absent, negative, or carries more
 * precision than the currency has. That last case is routine here rather than
 * theoretical: Fincra reports `fee: 9090.909091` and balances like `4145.558824`, and
 * reporting those as a rounded number of kobo would state a figure Fincra never gave.
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
  const email = asString(bag.email);
  // Fincra names a customer in three ways depending on the endpoint: `name` on a
  // checkout, firstName/lastName on a beneficiary, accountHolderName on a payout.
  const first = asString(bag.firstName);
  const last = asString(bag.lastName);
  const name =
    asString(bag.name) ??
    asString(bag.accountHolderName) ??
    (first || last ? [first, last].filter(Boolean).join(" ") : undefined);
  const phone = asString(bag.phoneNumber) ?? asString(bag.phone);
  const code = asString(bag._id) ?? asString(bag.id);
  if (!email && !name && !phone) return null;
  return {
    email: email ?? null,
    name: name ?? null,
    phone: phone ?? null,
    providerCustomerCode: code ?? null,
  };
}

export interface Transaction {
  /** Your own reference — Fincra's `merchantReference`. */
  readonly reference: string;
  /** Fincra's own `reference`, e.g. `fcr-p-700ju9sf`. */
  readonly providerReference: string;
  readonly status: TransactionStatus;
  readonly amount: Money | null;
  /**
   * What the money became after conversion, when the customer paid in another currency.
   *
   * Fincra is a cross-border provider, so `convertedAmount` and `convertedCurrency` are
   * routine rather than exotic, and they are not the same as `amount`.
   */
  readonly convertedAmount: Money | null;
  readonly fees: Money | null;
  readonly channel: Channel | null;
  readonly channels: readonly Channel[];
  readonly paidAt: Date | null;
  readonly createdAt: Date | null;
  readonly customer: Customer | null;
  /** Who bears the Fincra fee: `customer` or `business`. */
  readonly feeBearer: string | null;
  readonly provider: string;
  readonly raw: unknown;
}

export function toTransaction(data: unknown): Transaction {
  const bag = asRecord(data);
  const currency = asString(bag.currency) ?? "NGN";

  const methods = Array.isArray(bag.paymentMethods) ? (bag.paymentMethods as unknown[]) : [];
  const channels: Channel[] = [];
  for (const method of methods) {
    const channel = normaliseChannel(method);
    if (channel !== null && !channels.includes(channel)) channels.push(channel);
  }

  return {
    reference: asString(bag.merchantReference) ?? asString(bag.customerReference) ?? "",
    providerReference: asString(bag.reference) ?? "",
    status: normaliseStatus(bag.status),
    amount: asMoney(bag.amount, currency),
    convertedAmount: asMoney(bag.convertedAmount, asString(bag.convertedCurrency) ?? currency),
    fees: asMoney(bag.fee, currency),
    channel: normaliseChannel(bag.defaultPaymentMethod ?? bag.paymentMethod),
    channels,
    paidAt: asDate(bag.updatedAt ?? bag.valuedAt),
    createdAt: asDate(bag.createdAt),
    customer: toCustomer(bag.customer),
    feeBearer: asString(bag.feeBearer) ?? null,
    provider: FINCRA_PROVIDER_NAME,
    raw: data,
  };
}

export interface BankAccount {
  readonly accountNumber: string;
  readonly accountName: string;
  readonly bankName: string | null;
  /** Fincra's own code, authoritative for calling Fincra. Never substituted. */
  readonly bankCode: string | null;
  /** Fincra's own id for the bank, from GET /core/banks. */
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
    provider: FINCRA_PROVIDER_NAME,
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
  /** Your own `merchantReference`, when you set one. */
  readonly reference: string;
  /** Fincra's `_id`, which is what every other virtual-account call takes. */
  readonly id: string | null;
  readonly accounts: readonly BankAccount[];
  readonly kind: "static" | "dynamic";
  readonly status: "active" | "inactive";
  readonly customer: Customer | null;
  /**
   * Fincra's own request status, mapped onto ours.
   *
   * `approved` is the only one that means the account is usable. `pending` and
   * `reviewed` mean Fincra is still looking, `declined` means it refused, and `expired`
   * and `closed` mean the account is gone. NGN requests are documented as approved
   * instantly, but the field is still read rather than assumed.
   */
  readonly kycStatus: "pending" | "verified" | "failed" | "not_required";
  readonly currency: string | null;
  /** `individual` or `corporate`. */
  readonly accountType: string | null;
  readonly expiresAt: Date | null;
  readonly createdAt: Date | null;
  readonly provider: string;
  readonly raw: unknown;
}

const VA_STATUS_MAP: Record<string, VirtualAccount["kycStatus"]> = {
  approved: "verified",
  pending: "pending",
  reviewed: "pending",
  declined: "failed",
  expired: "failed",
  closed: "failed",
};

/**
 * The one NUBAN on a Fincra virtual account.
 *
 * Fincra nests it under `accountInformation`, except on the temporary-account response,
 * where the number is at the top level. No account number means no account.
 */
function toAccounts(bag: Record<string, unknown>): BankAccount[] {
  const info = asRecord(bag.accountInformation);
  const accountNumber = asString(info.accountNumber) ?? asString(bag.accountNumber);
  if (accountNumber === undefined || accountNumber === "") return [];
  const bankName = asString(info.bankName);
  const bankCode = asString(info.bankCode);
  return [
    enrich({
      accountNumber,
      accountName: asString(info.accountName) ?? "",
      ...(bankName === undefined ? {} : { bankName }),
      ...(bankCode === undefined ? {} : { bankCode }),
    }),
  ];
}

/**
 * Static or dynamic.
 *
 * `isPermanent` is Fincra's own flag and is authoritative. The caller's intent and the
 * expiry are only consulted when it is absent, and an account with no expiry is treated
 * as static because that is what a permanent account looks like.
 */
function toKind(
  bag: Record<string, unknown>,
  context: { kind?: "static" | "dynamic" },
  expiresAt: Date | null,
): "static" | "dynamic" {
  if (bag.isPermanent === true) return "static";
  if (bag.isPermanent === false) return "dynamic";
  if (context.kind !== undefined) return context.kind;
  return expiresAt === null ? "static" : "dynamic";
}

export function toVirtualAccount(
  data: unknown,
  context: { reference?: string; kind?: "static" | "dynamic" } = {},
): VirtualAccount {
  const bag = asRecord(data);
  const accounts = toAccounts(bag);
  const status = asString(bag.status)?.trim().toLowerCase();
  const expiresAt = asDate(bag.expiresAt);

  return {
    reference: context.reference ?? asString(bag.merchantReference) ?? "",
    id: asString(bag._id) ?? null,
    accounts,
    kind: toKind(bag, context, expiresAt),
    // Two separate flags, and an account is only usable when both agree: Fincra can
    // suspend an account that is still marked active.
    status: bag.isActive === false || bag.isSuspended === true ? "inactive" : "active",
    customer: toCustomer(bag.KYCInformation),
    kycStatus: (status === undefined ? undefined : VA_STATUS_MAP[status]) ?? "pending",
    currency: asString(bag.currency) ?? null,
    accountType: asString(bag.accountType) ?? null,
    expiresAt,
    createdAt: asDate(bag.createdAt),
    provider: FINCRA_PROVIDER_NAME,
    raw: data,
  };
}

export interface Payout {
  /** Your own `customerReference`. */
  readonly reference: string;
  /** Fincra's own `reference`. */
  readonly providerReference: string;
  readonly status: TransactionStatus;
  /** What left your balance — Fincra's `amountSent`. */
  readonly amount: Money | null;
  /** What the beneficiary receives, in the destination currency. */
  readonly amountReceived: Money | null;
  readonly fee: Money | null;
  readonly recipient: BankAccount | null;
  readonly failureReason: string | null;
  readonly recipientId: string | null;
  /**
   * True when Fincra is waiting for a document before it will process the payout.
   *
   * `isDocumentRequired` on a created payout, which a cross-border payout can set.
   * Nothing moves until the document is uploaded, so this is Fincra's equivalent of
   * Monnify's OTP gate: a payout that looks accepted and is not going anywhere.
   */
  readonly awaitingDocument: boolean;
  readonly documentsRequired: readonly string[];
  readonly sourceCurrency: string | null;
  readonly destinationCurrency: string | null;
  readonly createdAt: Date | null;
  readonly provider: string;
  readonly raw: unknown;
}

export function toPayout(data: unknown): Payout {
  const bag = asRecord(data);
  const source = asString(bag.sourceCurrency) ?? "NGN";
  const destination = asString(bag.destinationCurrency) ?? source;
  const recipient = asRecord(bag.recipient ?? bag.beneficiary);

  const accountNumber = asString(recipient.accountNumber);
  const bankName = asString(recipient.bankName);
  const bankCode = asString(recipient.bankCode);
  const holder =
    asString(recipient.accountHolderName) ??
    asString(recipient.name) ??
    [asString(recipient.firstName), asString(recipient.lastName)].filter(Boolean).join(" ");

  const documents = Array.isArray(bag.documentsRequired)
    ? (bag.documentsRequired as unknown[]).map((entry) => asString(entry) ?? "").filter(Boolean)
    : [];

  return {
    reference: asString(bag.customerReference) ?? "",
    providerReference: asString(bag.reference) ?? "",
    status: normalisePayoutStatus(bag.status),
    amount: asMoney(bag.amountSent ?? bag.amountCharged ?? bag.amount, source),
    amountReceived: asMoney(bag.amountReceived, destination),
    fee: asMoney(bag.fee, asString(bag.feeCurrency) ?? source),
    recipient:
      accountNumber === undefined
        ? null
        : enrich({
            accountNumber,
            accountName: holder || "",
            ...(bankName === undefined ? {} : { bankName }),
            ...(bankCode === undefined ? {} : { bankCode }),
          }),
    // Fincra puts the human explanation in `message` and the business one in `reason`,
    // and which is populated depends on the endpoint.
    failureReason: asString(bag.reason) ?? asString(bag.message) ?? null,
    recipientId: asString(recipient._id) ?? asString(recipient.id) ?? null,
    // Fincra sends this as 0/1 on some endpoints and true/false on others.
    awaitingDocument: bag.isDocumentRequired === true || bag.isDocumentRequired === 1,
    documentsRequired: documents,
    sourceCurrency: asString(bag.sourceCurrency) ?? null,
    destinationCurrency: asString(bag.destinationCurrency) ?? null,
    createdAt: asDate(bag.createdAt),
    provider: FINCRA_PROVIDER_NAME,
    raw: data,
  };
}

export interface Refund {
  readonly reference: string;
  readonly providerReference: string;
  readonly collectionReference: string | null;
  readonly status: "pending" | "processing" | "processed" | "failed";
  readonly amount: Money | null;
  /** Why Fincra is refunding: `overpayment`, `underpayment` or a fixed-variance refund. */
  readonly reason: string | null;
  readonly destination: BankAccount | null;
  readonly provider: string;
  readonly raw: unknown;
}

const REFUND_STATUS_MAP: Record<string, Refund["status"]> = {
  pending: "pending",
  initiated: "pending",
  processing: "processing",
  success: "processed",
  successful: "processed",
  processed: "processed",
  completed: "processed",
  failed: "failed",
};

export function toRefund(data: unknown): Refund {
  const bag = asRecord(data);
  const payee = asRecord(bag.payee);
  const status = asString(bag.refundStatus ?? bag.status)
    ?.trim()
    .toLowerCase();

  const accountNumber = asString(payee.accountNumber) ?? asString(bag.payeeAccountNumber);
  const bankName = asString(payee.bankName);
  const bankCode = asString(payee.bankCode);

  return {
    reference: asString(bag.collectionMerchantReference) ?? "",
    providerReference: asString(bag.reference) ?? "",
    collectionReference: asString(bag.collectionReference) ?? null,
    status: (status === undefined ? undefined : REFUND_STATUS_MAP[status]) ?? "pending",
    amount: asMoney(bag.amountRefunded, asString(bag.currency) ?? "NGN"),
    reason: asString(bag.refundType ?? bag.collectionVarianceType) ?? null,
    destination:
      accountNumber === undefined
        ? null
        : enrich({
            accountNumber,
            accountName: "",
            ...(bankName === undefined ? {} : { bankName }),
            ...(bankCode === undefined ? {} : { bankCode }),
          }),
    provider: FINCRA_PROVIDER_NAME,
    raw: data,
  };
}

export interface WalletBalance {
  readonly currency: string;
  readonly available: Money | null;
  readonly ledger: Money | null;
  /** Money committed to payouts that have not settled. */
  readonly locked: Money | null;
  readonly walletNumber: string | null;
  readonly status: string | null;
  readonly provider: string;
  readonly raw: unknown;
}

export function toWalletBalance(data: unknown): WalletBalance {
  const bag = asRecord(data);
  const currency = asString(bag.currency) ?? "NGN";
  return {
    currency,
    available: asMoney(bag.availableBalance, currency),
    ledger: asMoney(bag.ledgerBalance, currency),
    locked: asMoney(bag.lockedBalance, currency),
    walletNumber: asString(bag.walletNumber) ?? null,
    status: asString(bag.status) ?? null,
    provider: FINCRA_PROVIDER_NAME,
    raw: data,
  };
}

export interface Bank {
  readonly name: string;
  /** Fincra's code, which is what a payout's `bankCode` must be. */
  readonly code: string;
  readonly id: string | null;
  /**
   * The NIBSS code, where Fincra publishes it.
   *
   * Fincra is the only Tier 1 provider that returns the NIP code alongside its own, so
   * this is worth carrying through: it is the code that identifies an institution across
   * every Nigerian provider.
   */
  readonly nipCode: string | null;
  readonly swiftCode: string | null;
  readonly isMobileMoney: boolean;
  readonly isCashPickup: boolean;
  readonly provider: string;
  readonly raw: unknown;
}

export function toBank(data: unknown): Bank {
  const bag = asRecord(data);
  return {
    name: asString(bag.name) ?? "",
    code: asString(bag.code) ?? "",
    id: asString(bag.id) ?? null,
    nipCode: asString(bag.nibssCode) ?? null,
    swiftCode: asString(bag.swiftCode) ?? asString(bag.bic) ?? null,
    isMobileMoney: bag.isMobileVerified === true,
    isCashPickup: bag.isCashPickUp === true,
    provider: FINCRA_PROVIDER_NAME,
    raw: data,
  };
}

export interface BvnVerification {
  readonly verified: boolean;
  readonly firstName: string | null;
  readonly middleName: string | null;
  readonly lastName: string | null;
  readonly gender: string | null;
  /** Fincra's own string, e.g. `15-Jul-2022`. Not parsed: see the note in the adapter. */
  readonly dateOfBirth: string | null;
  readonly phone: string | null;
  readonly provider: string;
  /**
   * The raw payload **with the photograph removed**.
   *
   * Fincra returns `pixBase64`, a photograph of the person. Carrying it in `raw` would
   * put biometric data into every log line and error report that touches this object, so
   * it is dropped here. NDPA 2023 treats a photograph as personal data; see SECURITY.md.
   */
  readonly raw: unknown;
}

export function toBvnVerification(data: unknown): BvnVerification {
  const bag = asRecord(data);
  const response = asRecord(bag.response);

  // Copied without pixBase64, so the photograph never reaches `raw`.
  const { pixBase64: _photograph, ...safeResponse } = response;

  return {
    verified: asString(bag.verificationStatus)?.toLowerCase() === "verified",
    firstName: asString(response.firstName) ?? null,
    middleName: asString(response.middleName) ?? null,
    lastName: asString(response.lastName) ?? null,
    gender: asString(response.gender) ?? null,
    dateOfBirth: asString(response.dateOfBirth) ?? null,
    phone: asString(response.phoneNo) ?? null,
    provider: FINCRA_PROVIDER_NAME,
    raw: { ...bag, response: safeResponse },
  };
}

/**
 * A Fincra list page.
 *
 * Fincra pages as `{results, total}` on some endpoints and as a bare array on others, so
 * both are accepted and reported the same way.
 */
export interface Page<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly raw: unknown;
}

export function toPage<T>(data: unknown, map: (item: unknown) => T): Page<T> {
  if (Array.isArray(data)) {
    const items = (data as unknown[]).map(map);
    return { items, total: items.length, raw: data };
  }
  const bag = asRecord(data);
  const results = Array.isArray(bag.results) ? (bag.results as unknown[]) : [];
  const items = results.map(map);
  return {
    items,
    total: typeof bag.total === "number" ? bag.total : items.length,
    raw: data,
  };
}
