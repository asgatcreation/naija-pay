/**
 * Bank and institution matching.
 *
 * Read the bank-codes section of DESIGN.md before changing anything here. The short
 * version, which is a money-safety rule rather than a preference:
 *
 *   **The provider's own bank code is authoritative for calling that provider, and
 *   naija-pay never substitutes it.**
 *
 * The data in this module is an *enrichment* layer from naija-data. It answers "is
 * Paystack's bank X the same institution as Monnify's bank Y?", supplies the canonical
 * name and type, and — the two things a payout flow genuinely benefits from — says when
 * an institution has been **merged into another**, and when a code naija-data carries
 * is **unverified upstream**.
 *
 * It is deliberately not a code lookup table. Measured on 2026-10-26, naija-data has a
 * NIP code for only 49 of 898 institutions, while Paystack alone returns 292 Nigerian
 * banks under its own codes in three different lengths. Matching is therefore
 * best-effort, every match records how it was made, and misses are reported rather than
 * guessed at.
 */

import data from "../data/banks.json" with { type: "json" };

export type InstitutionType =
  | "commercial"
  | "merchant"
  | "non_interest"
  | "payment_service_bank"
  | "mobile_money_operator"
  | "microfinance"
  | "mortgage"
  | "development_finance";

export interface Institution {
  /** Canonical, stable identifier from naija-data, e.g. "access-bank". */
  readonly id: string;
  readonly name: string;
  readonly shortName?: string;
  readonly type: InstitutionType;
  readonly status: "active" | "merged";
  /** NIBSS 6-digit code, where naija-data has one. */
  readonly nipCode?: string;
  /** CBN 3- or 5-digit code, where naija-data has one. */
  readonly cbnCode?: string;
  /** Where a merged institution went. Providers still return merged banks' codes. */
  readonly mergedInto?: string;
  readonly aliases?: readonly string[];
  /** Codes naija-data could not verify against a primary source. */
  readonly unverified?: readonly ("cbnCode" | "nipCode")[];
}

export interface BankDataSource {
  readonly repository: string;
  readonly file: string;
  readonly dataVersion: string;
  readonly licence: string;
  readonly attribution: string;
}

const DATASET = data as unknown as {
  source: BankDataSource;
  banks: Institution[];
};

/** Every institution naija-data carries that can still receive money. */
export const institutions: readonly Institution[] = Object.freeze(DATASET.banks);

/**
 * Provenance for the dataset, including the CC BY 4.0 attribution naija-data requires.
 * Exported so an application that displays bank data can honour the licence.
 */
export const bankDataSource: BankDataSource = Object.freeze(DATASET.source);

const byId = new Map<string, Institution>();
const byNipCode = new Map<string, Institution>();
const byCbnCode = new Map<string, Institution>();
const byNormalisedName = new Map<string, Institution>();

/**
 * Normalise a bank name for comparison.
 *
 * Providers spell the same institution many ways: "Guaranty Trust Bank",
 * "GTBank", "GTB", "Guaranty Trust Bank Plc". Corporate suffixes and the word "bank"
 * carry no distinguishing information, so they are dropped — "Access Bank Plc" and
 * "Access" then agree.
 */
export function normaliseBankName(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(plc|limited|ltd|nigeria|ng|company|co)\b/g, " ")
    .replace(/\b(bank|banks|banking)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Active institutions are indexed first and win any collision. Merged ones are indexed
// afterwards only where their code is still free — providers really do keep serving the
// old codes (Paystack lists "Access Bank (Diamond)" under Diamond's 063), and matching
// them is what makes the merger warning reachable instead of decorative.
for (const pass of ["active", "merged"] as const) {
  for (const institution of DATASET.banks) {
    if (institution.status !== pass) continue;
    if (institution.nipCode && !byNipCode.has(institution.nipCode)) {
      byNipCode.set(institution.nipCode, institution);
    }
    if (institution.cbnCode && !byCbnCode.has(institution.cbnCode)) {
      byCbnCode.set(institution.cbnCode, institution);
    }
  }
}

for (const institution of DATASET.banks) {
  byId.set(institution.id, institution);
  for (const candidate of [
    institution.name,
    institution.shortName,
    ...(institution.aliases ?? []),
  ]) {
    if (!candidate) continue;
    const key = normaliseBankName(candidate);
    // First writer wins, so a commercial bank is not displaced by a microfinance bank
    // with a similar name. The file is sorted by id, which makes that deterministic.
    if (key !== "" && !byNormalisedName.has(key)) byNormalisedName.set(key, institution);
  }
}

export type MatchedBy = "nip_code" | "cbn_code" | "name" | "alias";

export interface InstitutionMatch {
  readonly institution: Institution;
  /** How the match was made, so a weak match is visible rather than assumed. */
  readonly matchedBy: MatchedBy;
}

/** Look an institution up by its canonical naija-data id. */
export function institutionById(id: string): Institution | undefined {
  return byId.get(id);
}

/**
 * Best-effort match for a bank as some provider described it.
 *
 * Codes are tried first and only against the length they can plausibly be — a 6-digit
 * code is a NIP code, a 3- or 5-digit code is a CBN code. A provider code of any other
 * length is that provider's own identifier and is not looked up at all, because
 * matching it against a NIP code would be a coincidence rather than a fact.
 *
 * Returns `undefined` rather than guessing. An unmatched bank is still perfectly
 * usable: the provider's code remains authoritative.
 */
export function matchInstitution(bank: {
  readonly code?: string;
  readonly name?: string;
}): InstitutionMatch | undefined {
  const code = bank.code?.trim();
  if (code) {
    if (/^\d{6}$/.test(code)) {
      const hit = byNipCode.get(code);
      if (hit) return { institution: hit, matchedBy: "nip_code" };
    }
    if (/^\d{3}$|^\d{5}$/.test(code)) {
      const hit = byCbnCode.get(code);
      if (hit) return { institution: hit, matchedBy: "cbn_code" };
    }
  }

  if (bank.name) {
    const key = normaliseBankName(bank.name);
    const hit = byNormalisedName.get(key);
    if (hit) {
      // Distinguish a hit on the official name from one on an alias or short name, so
      // the caller can tell how confident the match is.
      const official = normaliseBankName(hit.name) === key;
      return { institution: hit, matchedBy: official ? "name" : "alias" };
    }
  }

  return undefined;
}

export interface MergerWarning {
  readonly institution: Institution;
  readonly mergedInto: Institution | undefined;
  readonly message: string;
}

/**
 * If this institution has been merged into another, describe it.
 *
 * Worth surfacing before a payout: providers still return merged institutions' codes,
 * and a developer settling to one deserves to know the bank no longer exists on its own.
 */
export function mergerWarningFor(institution: Institution): MergerWarning | undefined {
  if (institution.status !== "merged" || !institution.mergedInto) return undefined;
  const target = byId.get(institution.mergedInto);
  return {
    institution,
    mergedInto: target,
    message:
      `${institution.name} has been merged into ${target?.name ?? institution.mergedInto}. ` +
      "Providers may still return its old code; confirm the destination before settling.",
  };
}

/** Which of an institution's codes naija-data could not verify upstream. */
export function unverifiedCodesFor(institution: Institution): readonly string[] {
  return institution.unverified ?? [];
}

export interface CoverageReport {
  readonly provider: string;
  readonly total: number;
  readonly matched: number;
  readonly byMethod: Readonly<Record<MatchedBy, number>>;
  readonly unmatched: readonly { readonly code?: string; readonly name?: string }[];
}

/**
 * How much of a provider's bank list can be matched to an institution.
 *
 * Used by `npm run report:banks`. Unmatched banks are a naija-data issue to fix, not a
 * reason to fail a build — which is why this returns a report instead of throwing.
 */
export function coverageFor(
  provider: string,
  banks: readonly { readonly code?: string; readonly name?: string }[],
): CoverageReport {
  const byMethod: Record<MatchedBy, number> = {
    nip_code: 0,
    cbn_code: 0,
    name: 0,
    alias: 0,
  };
  const unmatched: { code?: string; name?: string }[] = [];

  for (const bank of banks) {
    const match = matchInstitution(bank);
    if (match) byMethod[match.matchedBy]++;
    else unmatched.push(bank);
  }

  return {
    provider,
    total: banks.length,
    matched: banks.length - unmatched.length,
    byMethod: Object.freeze(byMethod),
    unmatched: Object.freeze(unmatched),
  };
}
