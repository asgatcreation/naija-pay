/**
 * The Fincra half of the parity runner, kept separate so `ts-runner.mjs` stays readable
 * as more adapters land.
 *
 * Fincra is where the money boundary is widest: it reports fees like `9090.909091` and
 * balances like `4145.558824`, amounts no currency can represent, and both packages must
 * refuse exactly those and accept exactly the rest. Its refund timestamps are also
 * zoneless (`"2023-12-07 17:39:00"`), the shape that JavaScript reads as local time and
 * Python returns naive, so the dates are compared here too.
 *
 * `majorToString` is included because Fincra's temporary-virtual-account endpoint types
 * `amount` as a string: `str(350.0)` in Python is `"350.0"` while `String(350)` in
 * JavaScript is `"350"`, and this group is what keeps the two from drifting apart.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

export async function fincraParity(root, load, cases) {
  const normalise = await load("providers", "fincra", "normalise.ts");
  const money = await load("core", "money.ts");

  const base = path.join(root, "fixtures", "providers", "fincra");
  const fixtureResponse = (name) =>
    JSON.parse(readFileSync(path.join(base, name, "response.json"), "utf8"));

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
      convertedAmount: asMoney(t.convertedAmount),
      fees: asMoney(t.fees),
      channel: t.channel,
      channels: [...t.channels],
      paidAt: date(t.paidAt),
      createdAt: date(t.createdAt),
      customer: customer(t.customer),
      feeBearer: t.feeBearer,
      provider: t.provider,
    }),

    virtual_account: (v) => ({
      reference: v.reference,
      id: v.id,
      accounts: v.accounts.map(bankAccount),
      kind: v.kind,
      status: v.status,
      customer: customer(v.customer),
      kycStatus: v.kycStatus,
      currency: v.currency,
      accountType: v.accountType,
      expiresAt: date(v.expiresAt),
      createdAt: date(v.createdAt),
      provider: v.provider,
    }),

    payout: (p) => ({
      reference: p.reference,
      providerReference: p.providerReference,
      status: p.status,
      amount: asMoney(p.amount),
      amountReceived: asMoney(p.amountReceived),
      fee: asMoney(p.fee),
      recipient: bankAccount(p.recipient),
      failureReason: p.failureReason,
      recipientId: p.recipientId,
      awaitingDocument: p.awaitingDocument,
      documentsRequired: [...p.documentsRequired],
      sourceCurrency: p.sourceCurrency,
      destinationCurrency: p.destinationCurrency,
      createdAt: date(p.createdAt),
      provider: p.provider,
    }),

    refund: (r) => ({
      reference: r.reference,
      providerReference: r.providerReference,
      collectionReference: r.collectionReference,
      status: r.status,
      amount: asMoney(r.amount),
      reason: r.reason,
      destination: bankAccount(r.destination),
      provider: r.provider,
    }),

    wallet_balance: (b) => ({
      currency: b.currency,
      available: asMoney(b.available),
      ledger: asMoney(b.ledger),
      locked: asMoney(b.locked),
      walletNumber: b.walletNumber,
      status: b.status,
      provider: b.provider,
    }),

    bank: (b) => ({
      name: b.name,
      code: b.code,
      id: b.id,
      nipCode: b.nipCode,
      swiftCode: b.swiftCode,
      isMobileMoney: b.isMobileMoney,
      isCashPickup: b.isCashPickup,
      provider: b.provider,
    }),

    bvn: (v) => ({
      verified: v.verified,
      firstName: v.firstName,
      middleName: v.middleName,
      lastName: v.lastName,
      gender: v.gender,
      dateOfBirth: v.dateOfBirth,
      phone: v.phone,
      provider: v.provider,
      // The photograph must be absent from `raw` in both languages, which is a privacy
      // guarantee rather than a formatting detail.
      rawHasPhotograph: JSON.stringify(v.raw ?? null).includes("pixBase64"),
    }),
  };

  const convert = {
    transaction: normalise.toTransaction,
    virtual_account: (data) => normalise.toVirtualAccount(data),
    payout: normalise.toPayout,
    refund: normalise.toRefund,
    wallet_balance: normalise.toWalletBalance,
    bank: normalise.toBank,
    bvn: normalise.toBvnVerification,
  };

  const out = {};

  out.fincraNormalise = cases.fincraNormalise.map((c) => {
    const response = fixtureResponse(c.fixture);
    // Fincra always wraps its payload in `data`. A payload that is a list is normalised
    // from its first element, which is enough to pin the shape.
    const payload = Array.isArray(response.data) ? response.data[0] : response.data;
    return {
      fixture: c.fixture,
      shape: c.shape,
      value: flatten[c.shape](convert[c.shape](payload)),
    };
  });

  out.fincraStatuses = cases.fincraStatuses.map((s) => normalise.normaliseStatus(s));
  out.fincraPayoutStatuses = cases.fincraPayoutStatuses.map((s) =>
    normalise.normalisePayoutStatus(s),
  );
  out.fincraChannels = cases.fincraChannels.map((c) => normalise.normaliseChannel(c));

  // The six-decimal amounts, which are the whole reason asMoney returns null rather
  // than rounding.
  out.fincraAmounts = cases.fincraAmounts.map((c) =>
    asMoney(normalise.asMoney(c.value, c.currency ?? "NGN")),
  );

  out.majorToString = cases.majorToString.map((c) => {
    try {
      return { ok: true, value: money.majorToString(money.money(c.amount, c.currency)) };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  return out;
}
