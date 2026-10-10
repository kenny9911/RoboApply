// server/src/features/compliance/index.ts — public surface (FND-5; owner WP-13).
//
// Other areas import from here only:
//   complianceService.implicitLabelMetadata / explicitFooterLine / logAiContentLabel
//     — exporters (WP-36b resume, WP-37 cover letters) label AI output;
//   explainMatch — the PIPL Art. 24 "Why this job" lines (feed WP-33, job WP-34);
//   validateSignupConsents / initialConsentFormState / recordConsent / listConsents
//     — signup and onboarding (WP-10, WP-11, WP-31) and /account/consents;
//   registerExportSection / registerArtifactStorageDeleter — extension points;
//   loadAiStackSnapshot(env) — AWAIT IT before a synchronous call that builds
//     a consent text, its hash or the cross-border requirement for the live
//     process (resolveConsentProse, servedConsentProseByHash,
//     validateSignupConsents, isConsentRequired, crossBorderConsentApplies):
//     those read the admin model overrides from the snapshot it loads, and
//     without it a cold instance answers from the environment alone.
//     listConsents, recordConsent and the routes here await it themselves;
//   publishedLegalDocVersion(brand, doc, env) — the version of a PUBLISHED
//     legal document, null while it is a draft (billing-cn records it with
//     `cn_pay_terms_ack`; no acceptance is recorded against a draft).

import type { ImplicitAiLabel } from './contract.js';
import { explicitFooterLine, implicitLabelMetadata, logAiContentLabel, type ImplicitLabelInput } from './aiLabel.js';

export * from './contract.js';
export { createComplianceAdminRouter, createComplianceRouter, createLegalPublicRouter } from './routes.js';
export { COMPLIANCE_WORK_KINDS } from './kinds.js';
export {
  IMPLICIT_LABEL_KEYS,
  explicitLabelEnabled,
  newAiContentId,
  explicitFooterLine,
  implicitLabelMetadata,
  logAiContentLabel,
} from './aiLabel.js';
export type { ImplicitLabelInput, LogAiContentLabelInput } from './aiLabel.js';
export { explainMatch, EXPLAIN_KEYS } from './explainMatch.js';
export type { ExplainDimension, ExplainMatchInput } from './explainMatch.js';
export {
  CONSENT_CATALOG,
  CONSENT_PROSE_LOCALES,
  CONSENT_PROSE_VERSION,
  cameraVideoOffered,
  consentDefinitionsFor,
  consentProseHash,
  findConsentDefinition,
  initialConsentFormState,
  isConsentApplicable,
  isConsentRequired,
  crossBorderApplies,
  crossBorderConsentApplies,
  isOffshore,
  listConsents,
  recordConsent,
  resolveConsentProse,
  servedConsentProseByHash,
  validateSignupConsents,
} from './consents.js';
export type { ConsentContext, ConsentDefinition, ConsentProseLocale, RecordConsentInput, ResolvedProse, SignupConsentCheck, SubmittedConsent } from './consents.js';
export { aiPlaceSentence, describeProcessor, offshoreProcessors, offshoreProcessorsSentence, unplacedProcessors } from './processingStatement.js';
export { addWorkingDays, piRequestDueAt } from './piRequests.js';
export { RETENTION_RULES, registerArtifactStorageDeleter, retentionCutoff, retentionSchedule } from './retention.js';
export { aiLeavesMainland, buildDisclosures, buildLegalFooter, configuredModels, configuredProcessors, dataAttributions, llmEndpointFacts, llmEndpointRule, loadAiStackSnapshot, processingFacts } from './disclosures.js';
export { legalDocsVersion, publishedLegalDocVersion } from './legalDocs.js';
export { registerExportSection } from './dataExport.js';

export interface ComplianceService {
  /** Machine-readable AI label for an exported artifact (WP-36b/37 call it). */
  implicitLabelMetadata(artifact: ImplicitLabelInput): ImplicitAiLabel;
  /** Explicit footer line for a locale (GoApply exports when enabled). */
  explicitFooterLine(locale: string): string;
  /** Writes `RAAiContentLabelLog` (GoApply; RoboApply writes nothing). */
  logAiContentLabel(input: { userId: string | null; contentId: string; kind: string; provider: string; artifactId?: string | null }): Promise<void>;
}

export const complianceService: ComplianceService = {
  implicitLabelMetadata: (artifact) => implicitLabelMetadata(artifact),
  explicitFooterLine: (locale) => explicitFooterLine(locale),
  async logAiContentLabel(input) {
    await logAiContentLabel(input);
  },
};
