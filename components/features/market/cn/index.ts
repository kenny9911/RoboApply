// components/features/market/cn — GoApply job-card lines (届别, recruitment-info
// source, pay, quoted market tags, fraud warnings on own imports), external
// search links and the admin fraud review (TASK_PLAN.md WP-41).
//
// JobMetaCn is reached only through components/features/market/MarketJobMeta.tsx
// when brand.market === 'cn'; it reads `meta.cn` (server CnCardMeta).

export { JobMetaCn } from './JobMetaCn';
export { SalaryCn, type SalaryCnProps } from './SalaryCn';
export { ExternalSearchLinks, type ExternalSearchLinksProps } from './ExternalSearchLinks';
export { ExternalSearchPanel, type ExternalSearchPanelProps } from './ExternalSearchPanel';
export { FraudQueue } from './FraudQueue';
export { isOwnImport, readCnMeta, withOwnImport } from './meta';
