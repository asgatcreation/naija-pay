/**
 * Bank and institution matching, as its own entry point.
 *
 * Separate from the root export because it carries naija-data's institution registry —
 * around 20 KB gzipped — and an application that only needs money helpers, typed errors
 * or webhook verification should not pay for it. The provider adapters import this
 * module directly, so enrichment still happens without the caller doing anything.
 */

export {
  type BankDataSource,
  bankDataSource,
  type CoverageReport,
  coverageFor,
  type Institution,
  type InstitutionMatch,
  type InstitutionType,
  institutionById,
  institutions,
  type MatchedBy,
  type MergerWarning,
  matchInstitution,
  mergerWarningFor,
  normaliseBankName,
  unverifiedCodesFor,
} from "./core/banks.ts";
