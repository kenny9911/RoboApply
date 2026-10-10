// components/features/market/tw — Taiwan job-card lines from public job
// boards and the admin company job boards panel (TASK_PLAN.md WP-42).
//
// JobMetaTw is reached only through components/features/market/MarketJobMeta.tsx
// on RoboApply (market 'intl'); it reads `meta.ats_public` and renders nothing
// for non-Taiwan jobs. NegotiablePayNote explains 面議 (Employment Services Act
// Art. 5) wherever pay filters or job pages need it. CareerSourcesPanel is the
// /admin/sources page.

export { JobMetaTw } from './JobMetaTw';
export { NegotiablePayNote, TW_PAY_LAW_URL, type NegotiablePayNoteProps } from './NegotiablePayNote';
export { CareerSourcesPanel, boardReadUrl } from './CareerSourcesPanel';
export { readTwMeta } from './meta';
