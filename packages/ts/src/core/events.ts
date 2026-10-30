/**
 * Normalised events, and the inflow rules.
 *
 * Every provider's webhook becomes one of these shapes, keeps its raw payload, and
 * carries the honest `signatureStrength` it earned.
 *
 * The inflow rules are the part worth reading. Pay-by-transfer is where real money goes
 * wrong: a customer sends ₦4,900 for a ₦5,000 invoice, or ₦50,000 by mistake, or pays
 * twenty minutes after the dynamic account expired, or the provider delivers the same
 * notification three times. Every provider leaves these to you — only Korapay documents
 * guidance at all. So each case is a **named, configurable rule** here rather than
 * something each developer rediscovers in production.
 */

import { type Money, compare, money, subtract } from "./money.ts";
import type { SignatureStrength } from "./signatures.ts";

/**
 * The normalised event vocabulary.
 *
 * `unknown` is deliberate: an event type we have not mapped is still delivered,
 * verified, with its raw payload, rather than being dropped. A provider adding an event
 * must never break a running application.
 */
export type EventType =
  | "payment.successful"
  | "payment.failed"
  | "payment.pending"
  | "payment.reversed"
  | "virtual_account.credited"
  | "virtual_account.assigned"
  | "virtual_account.assignment_failed"
  | "transfer.successful"
  | "transfer.failed"
  | "transfer.reversed"
  | "refund.processed"
  | "refund.failed"
  | "subscription.created"
  | "subscription.disabled"
  | "subscription.charge_failed"
  | "mandate.approved"
  | "mandate.cancelled"
  | "mandate.debited"
  | "subaccount.settled"
  | "customer.identification_succeeded"
  | "customer.identification_failed"
  | "unknown";

export interface EventSender {
  /** As the provider reported it. Masked in logs by the redactor. */
  readonly name?: string;
  readonly bank?: string;
  readonly accountNumber?: string;
}

/** How an inflow's amount compares with what was expected. */
export type InflowVariance = "exact" | "overpayment" | "underpayment" | "unexpected";

export interface VirtualAccountInflow {
  readonly reference: string;
  readonly accountNumber: string;
  /** What the dynamic account asked for. Null for a static account with no amount. */
  readonly expectedAmount: Money | null;
  readonly amountPaid: Money;
  readonly fees: Money | null;
  readonly settledAmount: Money | null;
  readonly sender: EventSender | null;
  /** NIBSS session id, where the provider supplies one. */
  readonly sessionId: string | null;
  readonly paidAt: Date | null;
  /** When the account expired, for a dynamic account. */
  readonly expiresAt: Date | null;
  readonly variance: InflowVariance;
  /** Signed difference: positive when overpaid, negative when underpaid. */
  readonly varianceAmount: Money | null;
  readonly isLate: boolean;
}

export interface NaijaPayEvent<T = unknown> {
  /** Stable per provider event, and the key the idempotency store uses. */
  readonly id: string;
  readonly type: EventType;
  readonly occurredAt: Date;
  readonly provider: string;
  readonly signatureStrength: SignatureStrength;
  readonly data: T;
  /** The provider's untouched payload. Always available. */
  readonly raw: unknown;
  /** The provider's own event name, kept so `unknown` is still actionable. */
  readonly providerEvent?: string;
}

// --------------------------------------------------------------------- rules

export type OverpaymentAction = "credit_full" | "credit_expected" | "reject" | "manual_review";
export type UnderpaymentAction = "credit_partial" | "reject" | "manual_review";
export type LatePaymentAction = "accept" | "reject" | "manual_review";

export interface InflowRules {
  readonly overpayment: OverpaymentAction;
  readonly underpayment: UnderpaymentAction;
  readonly latePayment: LatePaymentAction;
}

/**
 * Defaults chosen to be conservative with other people's money.
 *
 * An overpayment is credited in full because the money genuinely arrived and refusing it
 * strands a customer's funds. An underpayment goes to review rather than being credited
 * partially, because partial credit silently changes what the customer bought. A late
 * payment is accepted, because the money has arrived and the expiry was our constraint,
 * not theirs.
 */
export const DEFAULT_INFLOW_RULES: InflowRules = {
  overpayment: "credit_full",
  underpayment: "manual_review",
  latePayment: "accept",
};

export type InflowDecision =
  | { readonly action: "credit"; readonly amount: Money; readonly reason: string }
  | { readonly action: "reject"; readonly reason: string }
  | { readonly action: "manual_review"; readonly reason: string }
  | { readonly action: "ignore"; readonly reason: string };

/** Classify an inflow against what was expected. */
export function classifyInflow(options: {
  readonly expectedAmount: Money | null;
  readonly amountPaid: Money;
  readonly paidAt?: Date | null;
  readonly expiresAt?: Date | null;
}): { variance: InflowVariance; varianceAmount: Money | null; isLate: boolean } {
  const { expectedAmount, amountPaid, paidAt, expiresAt } = options;

  const isLate =
    paidAt instanceof Date && expiresAt instanceof Date ? paidAt.getTime() > expiresAt.getTime() : false;

  if (expectedAmount === null) {
    // A static account has no expected amount, so no variance exists to report. This is
    // the normal case for wallet funding, not an anomaly.
    return { variance: "unexpected", varianceAmount: null, isLate };
  }

  const direction = compare(amountPaid, expectedAmount);
  if (direction === 0) {
    return { variance: "exact", varianceAmount: money(0, amountPaid.currency), isLate };
  }
  if (direction > 0) {
    return {
      variance: "overpayment",
      varianceAmount: subtract(amountPaid, expectedAmount),
      isLate,
    };
  }
  return {
    variance: "underpayment",
    // Kept positive; `variance` says which direction it is in.
    varianceAmount: subtract(expectedAmount, amountPaid),
    isLate,
  };
}

/**
 * Decide what to do with an inflow, given the rules.
 *
 * `alreadyProcessed` short-circuits everything: a duplicate delivery is always ignored,
 * and that is not configurable. Every Tier 1 provider retries webhooks — Paystack for 72
 * hours — so duplicates are certain, and "give value twice" must never be reachable
 * through configuration.
 */
export function decideInflow(options: {
  readonly inflow: Pick<
    VirtualAccountInflow,
    "expectedAmount" | "amountPaid" | "variance" | "isLate"
  >;
  readonly rules?: InflowRules;
  readonly alreadyProcessed?: boolean;
}): InflowDecision {
  const { inflow, alreadyProcessed = false } = options;
  const rules = options.rules ?? DEFAULT_INFLOW_RULES;

  if (alreadyProcessed) {
    return {
      action: "ignore",
      reason: "this event has already been processed; giving value twice is never correct",
    };
  }

  if (inflow.isLate) {
    if (rules.latePayment === "reject") {
      return { action: "reject", reason: "the payment arrived after the account expired" };
    }
    if (rules.latePayment === "manual_review") {
      return {
        action: "manual_review",
        reason: "the payment arrived after the account expired",
      };
    }
    // "accept" falls through to the amount rules below: being late does not change
    // whether the right amount arrived.
  }

  switch (inflow.variance) {
    case "exact":
      return { action: "credit", amount: inflow.amountPaid, reason: "the expected amount arrived" };

    case "unexpected":
      // No expected amount, so there is nothing to compare against: credit what came in.
      return {
        action: "credit",
        amount: inflow.amountPaid,
        reason: "a static account received funds, with no expected amount to compare",
      };

    case "overpayment":
      switch (rules.overpayment) {
        case "credit_full":
          return {
            action: "credit",
            amount: inflow.amountPaid,
            reason: "overpaid; crediting the full amount received",
          };
        case "credit_expected":
          return {
            action: "credit",
            amount: inflow.expectedAmount ?? inflow.amountPaid,
            reason: "overpaid; crediting the expected amount, the excess needs refunding",
          };
        case "reject":
          return { action: "reject", reason: "overpaid, and the rules reject overpayments" };
        case "manual_review":
          return { action: "manual_review", reason: "overpaid" };
      }
      break;

    case "underpayment":
      switch (rules.underpayment) {
        case "credit_partial":
          return {
            action: "credit",
            amount: inflow.amountPaid,
            reason: "underpaid; crediting only what arrived",
          };
        case "reject":
          return { action: "reject", reason: "underpaid, and the rules reject underpayments" };
        case "manual_review":
          return { action: "manual_review", reason: "underpaid" };
      }
  }

  /* c8 ignore next -- every variance and action is handled above */
  return { action: "manual_review", reason: "unclassified inflow" };
}

// -------------------------------------------------------------- idempotency

/**
 * Remembers which events have been processed, so one is never acted on twice.
 *
 * Deliberately tiny: an application supplies a Redis- or database-backed store in
 * production. The in-memory one is for development and tests, and says so.
 */
export interface IdempotencyStore {
  has(eventId: string): Promise<boolean> | boolean;
  mark(eventId: string): Promise<void> | void;
}

/**
 * In-memory store. Not for production: it forgets on restart and is not shared between
 * processes, so two instances would each give value once.
 */
export function memoryStore(): IdempotencyStore & { readonly size: () => number } {
  const seen = new Set<string>();
  return {
    has: (eventId) => seen.has(eventId),
    mark: (eventId) => {
      seen.add(eventId);
    },
    size: () => seen.size,
  };
}
