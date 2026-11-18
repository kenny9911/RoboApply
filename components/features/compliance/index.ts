// components/features/compliance — public surface of the compliance area (WP-13).
// Other areas import from here only (TASK_PLAN.md §2.1 rule 4).

export { SettingsSection as ComplianceSettingsSection } from './SettingsSection';
export { PrivacyPanel } from './PrivacyPanel';
export { ConsentsPanel } from './ConsentsPanel';
export { LegalDocument } from './LegalDocument';
export { LegalIndex } from './LegalIndex';
export { LegalFooterView } from './LegalFooterView';
export { AiBadgeView } from './AiBadgeView';
export { RetentionTable } from './RetentionTable';
export { CrossBorderNotice, DataAttributions, LlmEndpoints, ProcessingFacts, ProcessorsTable } from './DisclosureTables';
export { WhyThisJob } from './WhyThisJob';
export {
  LEGAL_DOC_FILES,
  LEGAL_FOOTER_DOCS,
  legalDocsFor,
} from './legalCatalog';
