/**
 * Capability declarations.
 *
 * Each adapter declares exactly what it can do. Two things follow from that, and both
 * are the point of this file:
 *
 * 1. An unsupported operation fails **locally, before any network call**, with a clear
 *    message — rather than degrading into something that looks like it worked.
 * 2. The capability matrix in the docs is generated from these declarations, so it
 *    cannot drift from the code.
 *
 * Some provider features exist in the documentation but need the provider's commercial
 * approval before they work in live mode. Monnify's own OpenAPI spec says this about
 * its Transfer API and its Sub Accounts. Those are declared `requiresApproval`, so
 * nobody designs around a feature they cannot switch on.
 */

import { UnsupportedOperationError } from "./errors.ts";

/**
 * Every operation in the normalised API. Adapters declare support per operation, and
 * the names match the method paths in DESIGN.md exactly.
 */
export type Operation =
  // Collections
  | "checkout.create"
  | "transactions.verify"
  | "transactions.list"
  | "refunds.create"
  | "refunds.status"
  // Virtual accounts
  | "virtualAccounts.createStatic"
  | "virtualAccounts.createDynamic"
  | "virtualAccounts.get"
  | "virtualAccounts.list"
  | "virtualAccounts.updateKyc"
  | "virtualAccounts.deactivate"
  | "virtualAccounts.listInflows"
  // Split-payment sub-accounts
  | "splitAccounts.create"
  | "splitAccounts.update"
  | "splitAccounts.list"
  | "splitAccounts.deactivate"
  | "splits.create"
  | "splits.update"
  | "splits.list"
  | "splits.settlements"
  // Wallet / banking sub-accounts
  | "wallets.onboardCustomer"
  | "wallets.open"
  | "wallets.balance"
  | "wallets.statement"
  | "wallets.transfer"
  | "wallets.freeze"
  | "wallets.unfreeze"
  | "wallets.close"
  // Payouts
  | "payouts.create"
  | "payouts.createBulk"
  | "payouts.status"
  | "banks.list"
  | "banks.resolveAccount"
  | "balance.get"
  // Recurring and mandates
  | "plans.create"
  | "subscriptions.create"
  | "charges.chargeAuthorization"
  | "mandates.create"
  | "mandates.status"
  | "mandates.debit"
  | "mandates.cancel"
  // Identity
  | "identity.verifyBvn"
  | "identity.verifyNin"
  // Webhooks
  | "webhooks.verify";

/** Payment channels a provider can present at checkout. */
export type Channel =
  | "card"
  | "bank_transfer"
  | "ussd"
  | "bank_account"
  | "qr"
  | "wallet"
  | "mobile_money"
  | "apple_pay"
  | "google_pay";

export interface OperationSupport {
  /**
   * Documented but gated behind the provider's commercial approval before it works in
   * live mode. The operation still runs; the flag exists so the capability matrix and
   * the docs can say so.
   */
  readonly requiresApproval?: boolean;
  /**
   * Implemented from documentation but not yet exercised against the provider's
   * sandbox. Surfaced in the docs so nobody mistakes "written" for "verified".
   */
  readonly notYetSandboxVerified?: boolean;
  /** Identity fields this provider requires for this operation, e.g. ["bvn"]. */
  readonly requiredKyc?: readonly string[];
  /** Anything a developer would be surprised by. Appears in the generated matrix. */
  readonly notes?: string;
}

export interface ProviderCapabilities {
  readonly provider: string;
  /** Operations this provider supports. Absent means unsupported. */
  readonly operations: Readonly<Partial<Record<Operation, OperationSupport>>>;
  readonly channels?: readonly Channel[];
  readonly currencies?: readonly string[];
  /**
   * How this provider's webhook signature actually works, as documented. See the
   * webhook table in PROVIDERS.md — three Tier 1 providers cannot offer full-body
   * integrity, and this is how an application finds that out in code.
   */
  readonly webhookSignature?: {
    readonly strength: "full-body" | "partial-body" | "shared-secret" | "unverified";
    readonly header?: string;
    readonly algorithm?: string;
    readonly notes?: string;
  };
}

/** Does this provider declare support for the operation at all? */
export function supports(caps: ProviderCapabilities, operation: Operation): boolean {
  return Object.hasOwn(caps.operations, operation);
}

/** The declaration for an operation, or undefined when unsupported. */
export function supportFor(
  caps: ProviderCapabilities,
  operation: Operation,
): OperationSupport | undefined {
  return caps.operations[operation];
}

/**
 * Throw unless this provider supports the operation.
 *
 * Every adapter method begins with this, so an unsupported call costs nothing and
 * explains itself. On Paystack, for example, `wallets.open` fails here: Paystack has
 * no wallet product, and pretending otherwise would be the worst thing this SDK could
 * do.
 */
export function assertSupported(caps: ProviderCapabilities, operation: Operation): void {
  if (!supports(caps, operation)) {
    throw new UnsupportedOperationError({
      provider: caps.provider,
      operation,
      reason: `See the capability matrix in PROVIDERS.md for which providers support ${operation}.`,
    });
  }
}

/** Operations needing provider approval before they work live. */
export function operationsRequiringApproval(caps: ProviderCapabilities): Operation[] {
  return (Object.entries(caps.operations) as [Operation, OperationSupport][])
    .filter(([, s]) => s.requiresApproval)
    .map(([op]) => op)
    .sort();
}

/** Operations implemented from docs but not yet sandbox-verified. */
export function operationsNotSandboxVerified(caps: ProviderCapabilities): Operation[] {
  return (Object.entries(caps.operations) as [Operation, OperationSupport][])
    .filter(([, s]) => s.notYetSandboxVerified)
    .map(([op]) => op)
    .sort();
}

/**
 * Identity fields required for an operation, so `KycRequiredError` can be raised
 * locally before a request is sent. Fincra, for instance, requires a BVN for NGN
 * permanent virtual accounts, and failing fast beats an opaque provider rejection.
 */
export function requiredKycFor(
  caps: ProviderCapabilities,
  operation: Operation,
): readonly string[] {
  return caps.operations[operation]?.requiredKyc ?? [];
}
