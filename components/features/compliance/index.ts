// components/features/compliance — public surface of the compliance area (WP-13).
// Other areas import from here only (TASK_PLAN.md §2.1 rule 4).

export { SettingsSection as ComplianceSettingsSection } from './SettingsSection';
export { PrivacyPanel } from './PrivacyPanel';
export { ConsentsPanel } from './ConsentsPanel';
export { LegalDocument, type LegalDocumentProps } from './LegalDocument';
export { LegalFooterView, type LegalFooterViewProps } from './LegalFooterView';
export { AiBadgeView, type AiBadgeKind } from './AiBadgeView';
export { RetentionTable } from './RetentionTable';
export { ModelsTable, ProcessorsTable } from './DisclosureTables';
export { WhyThisJob } from './WhyThisJob';
export {
  LEGAL_DOCS,
  LEGAL_DOC_FILES,
  LEGAL_DOC_ALIASES,
  LEGAL_DOC_MARKET_ALIASES,
  LEGAL_FOOTER_DOCS,
  legalDocsFor,
  resolveLegalDocSlug,
  splitLegalBlocks,
  type LegalDocSlug,
  type LegalMarket,
} from './legalCatalog';
