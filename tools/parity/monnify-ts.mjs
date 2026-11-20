/**
 * The Monnify half of the parity runner, kept separate so `ts-runner.mjs` stays
 * readable as more adapters land.
 *
 * Monnify is the adapter that most needs this check, for two reasons:
 *
 * 1. **Its dates are not ISO.** `"25/07/2022 11:20:20 AM"` is parsed by hand in both
 *    languages, and a 12-hour clock gives two chances to be an hour or twelve hours
 *    wrong. Worse, `createdOn` is `"2024-11-25 07:35:17.566"` — ISO-shaped with no
 *    timezone, which JavaScript reads as **local** time and Python's `fromisoformat`
 *    returns as a **naive** datetime. The same string would mean different instants in
 *    the two packages, and nothing but a parity case would notice. Both pin it to UTC.
 * 2. **Its webhook scheme was settled by a published vector.** The hash Monnify
 *    publishes is recomputed here in both languages, so neither can drift towards the
 *    (wrong) prose on its documentation page.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

export async function monnifyParity(root, load, cases) {
  const normalise = await load("providers", "monnify", "normalise.ts");
  const signatures = await load("core", "signatures.ts");

  const base = path.join(root, "fixtures", "providers", "monnify");
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
      destinationAccount: bankAccount(t.destinationAccount),
      sourceAccount: bankAccount(t.sourceAccount),
      provider: t.provider,
    }),

    virtual_account: (v) => ({
      reference: v.reference,
      accounts: v.accounts.map(bankAccount),
      kind: v.kind,
      status: v.status,
      customer: customer(v.customer),
      kycStatus: v.kycStatus,
      reservationReference: v.reservationReference,
      contractCode: v.contractCode,
      restrictPaymentSource: v.restrictPaymentSource,
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
      createdAt: date(p.createdAt),
      provider: p.provider,
    }),

    bulk_payout: (b) => ({
      batchReference: b.batchReference,
      status: b.status,
      totalAmount: asMoney(b.totalAmount),
      totalFee: asMoney(b.totalFee),
      transactionCount: b.transactionCount,
      successfulCount: b.successfulCount,
      failedCount: b.failedCount,
      pendingCount: b.pendingCount,
      awaitingOtp: b.awaitingOtp,
      createdAt: date(b.createdAt),
      provider: b.provider,
    }),

    refund: (r) => ({
      reference: r.reference,
      providerReference: r.providerReference,
      transactionReference: r.transactionReference,
      status: r.status,
      amount: asMoney(r.amount),
      destination: bankAccount(r.destination),
      provider: r.provider,
    }),

    split_account: (s) => ({
      code: s.code,
      businessName: s.businessName,
      settlementAccount: bankAccount(s.settlementAccount),
      defaultShareBasisPoints: s.defaultShareBasisPoints,
      email: s.email,
      provider: s.provider,
    }),

    bank: (b) => ({
      name: b.name,
      code: b.code,
      ussdTemplate: b.ussdTemplate,
      baseUssdCode: b.baseUssdCode,
      transferUssdTemplate: b.transferUssdTemplate,
      provider: b.provider,
    }),

    balance: (b) => ({
      accountNumber: b.accountNumber,
      available: asMoney(b.available),
      ledger: asMoney(b.ledger),
      provider: b.provider,
    }),

    page: (p) => ({
      page: p.page,
      pageSize: p.pageSize,
      total: p.total,
      totalPages: p.totalPages,
      hasMore: p.hasMore,
      items: p.items.map((item) => flatten.transaction(item)),
    }),
  };

  const convert = {
    transaction: normalise.toTransaction,
    virtual_account: normalise.toVirtualAccount,
    payout: normalise.toPayout,
    bulk_payout: normalise.toBulkPayout,
    refund: normalise.toRefund,
    split_account: normalise.toSplitAccount,
    bank: normalise.toBank,
    balance: (data) => normalise.toBalance(data, "3934178936"),
    page: (data) => normalise.toPage(data, normalise.toTransaction),
  };

  const out = {};

  out.monnifyNormalise = cases.monnifyNormalise.map((c) => {
    const response = fixtureResponse(c.fixture);
    // The envelope, except on the one endpoint that returns its payload at the top
    // level. A payload that is a list is normalised element by element from the first,
    // which is enough to pin the shape.
    const envelope = Object.hasOwn(response, "responseBody") ? response.responseBody : response;
    const payload = Array.isArray(envelope) ? envelope[0] : envelope;
    return {
      fixture: c.fixture,
      shape: c.shape,
      value: flatten[c.shape](convert[c.shape](payload)),
    };
  });

  out.monnifyStatuses = cases.monnifyStatuses.map((s) => normalise.normaliseStatus(s));
  out.monnifyTransferStatuses = cases.monnifyTransferStatuses.map((s) =>
    normalise.normaliseTransferStatus(s),
  );
  out.monnifyChannels = cases.monnifyChannels.map((c) => normalise.normaliseChannel(c));

  // The date formats, including the zoneless one. This is the group that would have
  // caught the local-time-versus-naive bug before it shipped.
  out.monnifyDates = cases.monnifyDates.map((value) => {
    const parsed = normalise.parseMonnifyDate(value);
    return parsed === null ? null : parsed.toISOString();
  });

  out.monnifyAmounts = cases.monnifyAmounts.map((c) =>
    asMoney(normalise.asMoney(c.value, c.currency ?? "NGN")),
  );

  // Monnify's own published webhook vector, recomputed in both languages.
  out.monnifyPublishedSignature = await (async () => {
    const published = JSON.parse(
      readFileSync(path.join(base, "webhook-successful-transaction", "published.json"), "utf8"),
    );
    const computed = await signatures.computeSignature(
      signatures.SCHEMES.monnify,
      new TextEncoder().encode(published.body),
      published.secret,
    );
    return { matchesPublished: computed === published.signature, computed };
  })();

  return out;
}
