import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  bankDataSource,
  coverageFor,
  institutionById,
  institutions,
  matchInstitution,
  mergerWarningFor,
  normaliseBankName,
  unverifiedCodesFor,
} from "../src/core/banks.ts";

describe("the dataset", () => {
  test("carries naija-data's CC BY 4.0 attribution, which the licence requires", () => {
    assert.match(bankDataSource.attribution, /naija-data/);
    assert.equal(bankDataSource.licence, "CC-BY-4.0");
    assert.match(bankDataSource.dataVersion, /^\d{4}-\d{2}-\d{2}$/);
  });

  test("contains the institutions we expect, and only payable ones", () => {
    assert.ok(institutions.length > 800, `only ${institutions.length} institutions`);
    for (const institution of institutions) {
      assert.ok(
        institution.status === "active" || institution.status === "merged",
        `${institution.id} has status ${institution.status}; revoked and defunct must be dropped`,
      );
    }
  });
});

describe("name normalisation", () => {
  test("collapses the many ways providers spell one bank", () => {
    assert.equal(normaliseBankName("Guaranty Trust Bank Plc"), "guaranty trust");
    assert.equal(normaliseBankName("Access Bank Plc"), "access");
    assert.equal(normaliseBankName("ACCESS BANK"), "access");
    assert.equal(normaliseBankName("First Bank of Nigeria Limited"), "first of");
    assert.equal(normaliseBankName("Stanbic IBTC Bank"), "stanbic ibtc");
  });

  test("expands an ampersand, so 'A & B' and 'A and B' agree", () => {
    assert.equal(normaliseBankName("Taj & Co Bank"), normaliseBankName("Taj and Bank"));
  });
});

describe("matching", () => {
  test("matches a 3-digit CBN code", () => {
    const match = matchInstitution({ code: "044", name: "Access Bank" });
    assert.equal(match?.institution.id, "access-bank");
    assert.equal(match?.matchedBy, "cbn_code");
  });

  test("matches a 6-digit NIBSS NIP code", () => {
    const match = matchInstitution({ code: "000014" });
    assert.equal(match?.institution.id, "access-bank");
    assert.equal(match?.matchedBy, "nip_code");
  });

  test("matches by official name, and distinguishes an alias match", () => {
    assert.equal(matchInstitution({ name: "Guaranty Trust Bank Plc" })?.matchedBy, "name");
    assert.equal(matchInstitution({ name: "GTBank" })?.matchedBy, "alias");
    assert.equal(
      matchInstitution({ name: "GTBank" })?.institution.id,
      matchInstitution({ name: "Guaranty Trust Bank Plc" })?.institution.id,
    );
  });

  test("prefers the code over the name when both are given", () => {
    // The code is the stronger signal, and a provider's display name may be decorated.
    const match = matchInstitution({ code: "044", name: "Something Else Entirely" });
    assert.equal(match?.institution.id, "access-bank");
    assert.equal(match?.matchedBy, "cbn_code");
  });

  test("ignores a code whose shape cannot be a NIP or CBN code", () => {
    // Paystack returns codes like "MFB50094" and "035A". Matching those against a
    // NIP code would be coincidence, not fact.
    assert.equal(matchInstitution({ code: "MFB50094" }), undefined);
    assert.equal(matchInstitution({ code: "035A" }), undefined);
    assert.equal(matchInstitution({ code: "1234567890" }), undefined);
  });

  test("returns undefined rather than guessing", () => {
    assert.equal(matchInstitution({ name: "Definitely Not A Real Bank Zzz" }), undefined);
    assert.equal(matchInstitution({}), undefined);
  });
});

describe("merged institutions", () => {
  test("a merged bank is still matchable by its old code, and warns", () => {
    // Paystack really does list "Access Bank (Diamond)" under Diamond's 063. Matching
    // it is what makes the warning reachable rather than decorative.
    const match = matchInstitution({ code: "063", name: "Access Bank (Diamond)" });
    assert.equal(match?.institution.id, "diamond-bank");

    const warning = mergerWarningFor(match!.institution);
    assert.ok(warning, "a merged institution must produce a warning");
    assert.equal(warning.mergedInto?.id, "access-bank");
    assert.match(warning.message, /merged into Access Bank/);
    assert.match(warning.message, /confirm the destination before settling/);
  });

  test("an active bank's own code still wins over a merged bank's", () => {
    const access = matchInstitution({ code: "044" });
    assert.equal(access?.institution.id, "access-bank");
    assert.equal(access?.institution.status, "active");
    assert.equal(mergerWarningFor(access!.institution), undefined);
  });

  test("every merger points at an institution we actually carry", () => {
    for (const institution of institutions) {
      if (institution.status !== "merged") continue;
      const warning = mergerWarningFor(institution);
      assert.ok(warning, `${institution.id} is merged but produced no warning`);
      assert.ok(
        warning.mergedInto,
        `${institution.id} merged into ${institution.mergedInto}, which is not in the dataset`,
      );
    }
  });
});

describe("unverified codes", () => {
  test("surfaces codes naija-data could not verify upstream", () => {
    const withUnverified = institutions.filter((i) => unverifiedCodesFor(i).length > 0);
    assert.ok(
      withUnverified.length > 0,
      "naija-data flags unverified codes; we must carry that through",
    );
    for (const institution of withUnverified) {
      for (const field of unverifiedCodesFor(institution)) {
        assert.ok(
          field === "cbnCode" || field === "nipCode",
          `${institution.id} flags an unexpected field: ${field}`,
        );
      }
    }
  });
});

describe("coverage reporting", () => {
  test("counts matches by method and lists the misses", () => {
    const report = coverageFor("testprovider", [
      { code: "044", name: "Access Bank" },
      { code: "000014", name: "Access Bank" },
      { name: "GTBank" },
      { code: "MFB50094", name: "Some Unknown MFB Ltd Zzz" },
    ]);

    assert.equal(report.provider, "testprovider");
    assert.equal(report.total, 4);
    assert.equal(report.matched, 3);
    assert.equal(report.byMethod.cbn_code, 1);
    assert.equal(report.byMethod.nip_code, 1);
    assert.equal(report.byMethod.alias, 1);
    assert.equal(report.unmatched.length, 1);
    assert.equal(report.unmatched[0]?.code, "MFB50094");
  });

  test("an empty list reports zero rather than dividing by zero", () => {
    const report = coverageFor("empty", []);
    assert.equal(report.total, 0);
    assert.equal(report.matched, 0);
    assert.equal(report.unmatched.length, 0);
  });
});

describe("lookup by id", () => {
  test("finds a known institution and misses an unknown one", () => {
    assert.equal(institutionById("access-bank")?.name, "Access Bank Plc");
    assert.equal(institutionById("no-such-bank"), undefined);
  });
});
