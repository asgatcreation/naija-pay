/**
 * The Paystack half of the parity runner, kept separate so `ts-runner.mjs` stays
 * readable as more adapters land.
 *
 * Normalises each recorded fixture and flattens the result into plain JSON, so the
 * Python side can be compared against it byte for byte. Money becomes
 * `{amount, currency}` and dates become ISO strings, because those are the two places
 * the languages would otherwise differ for uninteresting reasons.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

export async function paystackParity(root, load, cases) {
  const normalise = await load("providers", "paystack", "normalise.ts");

  const fixtureResponse = (name) =>
    JSON.parse(
      readFileSync(
        path.join(root, "fixtures", "providers", "paystack", name, "response.json"),
        "utf8",
      ),
    );

  const money = (value) =>
    value === null || value === undefined ? null : { amount: value.amount, currency: value.currency };
  const date = (value) => (value instanceof Date ? value.toISOString() : null);

  const flatten = {
    transaction: (t) => ({
      reference: t.reference,
      providerReference: t.providerReference,
      status: t.status,
      amount: money(t.amount),
      amountPaid: money(t.amountPaid),
      fees: money(t.fees),
      channel: t.channel,
      paidAt: date(t.paidAt),
      createdAt: date(t.createdAt),
      customer: t.customer
        ? {
            email: t.customer.email,
            name: t.customer.name,
            phone: t.customer.phone,
            providerCustomerCode: t.customer.providerCustomerCode,
          }
        : null,
      authorization: t.authorization
        ? {
            code: t.authorization.code,
            last4: t.authorization.last4,
            brand: t.authorization.brand,
            bank: t.authorization.bank,
            reusable: t.authorization.reusable,
            signature: t.authorization.signature,
          }
        : null,
      provider: t.provider,
    }),

    bankAccount: (a) =>
      a === null
        ? null
        : {
            accountNumber: a.accountNumber,
            accountName: a.accountName,
            bankName: a.bankName,
            bankCode: a.bankCode,
            bankSlug: a.bankSlug,
            provider: a.provider,
            institution: a.institution
              ? {
                  id: a.institution.id,
                  name: a.institution.name,
                  type: a.institution.type,
                  nipCode: a.institution.nipCode,
                  cbnCode: a.institution.cbnCode,
                  status: a.institution.status,
                  mergedInto: a.institution.mergedInto,
                  unverifiedCodes: [...a.institution.unverifiedCodes].sort(),
                  matchedBy: a.institution.matchedBy,
                }
              : null,
            mergerWarning: a.mergerWarning,
          },

    virtual_account: (v) => ({
      reference: v.reference,
      kind: v.kind,
      status: v.status,
      kycStatus: v.kycStatus,
      provider: v.provider,
      accounts: v.accounts.map((a) => flatten.bankAccount(a)),
      customer: v.customer
        ? {
            email: v.customer.email,
            name: v.customer.name,
            phone: v.customer.phone,
            providerCustomerCode: v.customer.providerCustomerCode,
          }
        : null,
    }),

    payout: (p) => ({
      reference: p.reference,
      providerReference: p.providerReference,
      status: p.status,
      amount: money(p.amount),
      recipientId: p.recipientId,
      awaitingOtp: p.awaitingOtp,
      provider: p.provider,
    }),

    refund: (r) => ({
      providerReference: r.providerReference,
      transactionReference: r.transactionReference,
      status: r.status,
      amount: money(r.amount),
      provider: r.provider,
    }),

    split_account: (s) => ({
      code: s.code,
      businessName: s.businessName,
      settlementAccount: flatten.bankAccount(s.settlementAccount),
      percentageCharge: s.percentageCharge,
      verified: s.verified,
      provider: s.provider,
    }),

    split: (s) => ({
      code: s.code,
      name: s.name,
      type: s.type,
      currency: s.currency,
      parties: s.parties.map((p) => ({ account: p.account, share: p.share })),
      provider: s.provider,
    }),
  };

  const convert = {
    transaction: normalise.toTransaction,
    virtual_account: normalise.toVirtualAccount,
    payout: normalise.toPayout,
    refund: normalise.toRefund,
    split_account: normalise.toSplitAccount,
    split: normalise.toSplit,
  };

  const out = {};

  out.paystackNormalise = cases.paystackNormalise.map((c) => {
    const response = fixtureResponse(c.fixture);
    const normalised = convert[c.shape](response.data);
    return { fixture: c.fixture, shape: c.shape, value: flatten[c.shape](normalised) };
  });

  out.paystackStatuses = cases.paystackStatuses.map((s) => normalise.normaliseStatus(s));
  out.paystackTransferStatuses = cases.paystackTransferStatuses.map((s) =>
    normalise.normaliseTransferStatus(s),
  );
  out.paystackChannels = cases.paystackChannels.map((c) => normalise.normaliseChannel(c));

  return out;
}
