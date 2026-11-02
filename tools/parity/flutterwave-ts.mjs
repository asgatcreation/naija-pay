/**
 * The Flutterwave half of the parity runner, kept separate so `ts-runner.mjs` stays
 * readable as more adapters land.
 *
 * Normalises each recorded fixture and flattens the result into plain JSON, so the
 * Python side can be compared against it byte for byte. Money becomes
 * `{amount, currency}` and dates become ISO strings, because those are the two places
 * the languages would otherwise differ for uninteresting reasons.
 *
 * Flutterwave is the first adapter whose wire format is decimal rather than minor
 * units, so these cases are also the cross-language check that both languages convert
 * `20000.5` to the same 2,000,050 kobo and refuse the same values. A float discrepancy
 * between two runtimes is exactly the kind of bug that would otherwise reach
 * production.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

export async function flutterwaveParity(root, load, cases) {
  const normalise = await load("providers", "flutterwave", "normalise.ts");
  const money = await load("core", "money.ts");

  const fixtureResponse = (name) =>
    JSON.parse(
      readFileSync(
        path.join(root, "fixtures", "providers", "flutterwave", name, "response.json"),
        "utf8",
      ),
    );

  const asMoney = (value) =>
    value === null || value === undefined
      ? null
      : { amount: value.amount, currency: value.currency };
  const date = (value) => (value instanceof Date ? value.toISOString() : null);

  const bankAccount = (a) =>
    a === null || a === undefined
      ? null
      : {
          accountNumber: a.accountNumber,
          accountName: a.accountName,
          bankName: a.bankName,
          bankCode: a.bankCode,
          bankId: a.bankId,
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
                unverifiedCodes: [...a.institution.unverifiedCodes],
                matchedBy: a.institution.matchedBy,
              }
            : null,
          mergerWarning: a.mergerWarning,
        };

  const customer = (c) =>
    c === null || c === undefined
      ? null
      : {
          email: c.email,
          name: c.name,
          phone: c.phone,
          providerCustomerCode: c.providerCustomerCode,
        };

  const flatten = {
    transaction: (t) => ({
      reference: t.reference,
      providerReference: t.providerReference,
      status: t.status,
      amount: asMoney(t.amount),
      amountPaid: asMoney(t.amountPaid),
      fees: asMoney(t.fees),
      amountSettled: asMoney(t.amountSettled),
      channel: t.channel,
      paidAt: date(t.paidAt),
      createdAt: date(t.createdAt),
      customer: customer(t.customer),
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
      transactionId: t.transactionId,
      provider: t.provider,
    }),

    virtual_account: (v) => ({
      reference: v.reference,
      accounts: v.accounts.map(bankAccount),
      kind: v.kind,
      status: v.status,
      customer: customer(v.customer),
      kycStatus: v.kycStatus,
      orderReference: v.orderReference,
      expiresAt: date(v.expiresAt),
      provider: v.provider,
    }),

    payout: (p) => ({
      reference: p.reference,
      providerReference: p.providerReference,
      status: p.status,
      amount: asMoney(p.amount),
      fee: asMoney(p.fee),
      recipient: bankAccount(p.recipient),
      failureReason: p.failureReason,
      recipientId: p.recipientId,
      awaitingOtp: p.awaitingOtp,
      awaitingApproval: p.awaitingApproval,
      provider: p.provider,
    }),

    refund: (r) => ({
      providerReference: r.providerReference,
      transactionReference: r.transactionReference,
      status: r.status,
      amount: asMoney(r.amount),
      provider: r.provider,
    }),

    split_account: (s) => ({
      code: s.code,
      businessName: s.businessName,
      settlementAccount: bankAccount(s.settlementAccount),
      percentageCharge: s.percentageCharge,
      flatCharge: asMoney(s.flatCharge),
      verified: s.verified,
      provider: s.provider,
    }),

    wallet_account: (w) => ({
      reference: w.reference,
      barterId: w.barterId,
      accountName: w.accountName,
      email: w.email,
      status: w.status,
      account: bankAccount(w.account),
      provider: w.provider,
    }),

    wallet_balance: (b) => ({
      reference: b.reference,
      available: asMoney(b.available),
      ledger: asMoney(b.ledger),
      provider: b.provider,
    }),
  };

  const convert = {
    transaction: normalise.toTransaction,
    virtual_account: normalise.toVirtualAccount,
    payout: normalise.toPayout,
    refund: normalise.toRefund,
    split_account: normalise.toSplitAccount,
    wallet_account: normalise.toWalletAccount,
    wallet_balance: (data) => normalise.toWalletBalance(data, "FALLBACK"),
  };

  const out = {};

  out.flutterwaveNormalise = cases.flutterwaveNormalise.map((c) => {
    const response = fixtureResponse(c.fixture);
    const normalised = convert[c.shape](response.data);
    return { fixture: c.fixture, shape: c.shape, value: flatten[c.shape](normalised) };
  });

  out.flutterwaveStatuses = cases.flutterwaveStatuses.map((s) => normalise.normaliseStatus(s));
  out.flutterwaveTransferStatuses = cases.flutterwaveTransferStatuses.map((s) =>
    normalise.normaliseTransferStatus(s),
  );
  out.flutterwaveChannels = cases.flutterwaveChannels.map((c) => normalise.normaliseChannel(c));

  // The decimal boundary, in both directions. Reported as the exact result or the
  // exact rejection message, so the two languages cannot diverge silently.
  out.toMajor = cases.toMajor.map((c) => {
    try {
      return { ok: true, value: money.toMajor(money.money(c.amount, c.currency)) };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  out.basisPointsToFraction = cases.basisPointsToFraction.map((bps) => {
    try {
      return { ok: true, value: money.basisPointsToFraction(bps) };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  return out;
}
