// components/features/market — the market slots (TASK_PLAN.md R-21).
// Shared UI imports these from here only (§2.1 rule 4); markets fill their
// own files: LegalFooter + AiGeneratedBadge (WP-13), PriceReference (WP-21b),
// cn/ (WP-41), tw/ (WP-42).

export { MarketJobMeta, marketMetaCoversBasics, marketPayLineText, marketPayWords } from './MarketJobMeta';
export type { MarketCardMeta, MarketJobMetaProps, MarketJobMetaSlotProps } from './types';
export { LegalFooter, type LegalFooterProps } from './LegalFooter';
export { AiGeneratedBadge, type AiGeneratedBadgeProps } from './AiGeneratedBadge';
export { PriceReference, type PriceReferenceProps } from './PriceReference';
// Taiwan pieces other areas place (WP-42; re-exported at the Wave 3 gate):
// the 面議 note beside pay filters / job pages, and the TW card-meta reader.
export { NegotiablePayNote, TW_PAY_LAW_URL, type NegotiablePayNoteProps, CareerSourcesPanel, readTwMeta } from './tw';
// GoApply pieces other areas place (WP-41; INT-06): the "search other job
// sites" panel for the jobs pages while GoApply lists no third-party posts,
// the reader of `meta.cn` (the pay text for the WeChat share card), and the
// marker for a job the user added (its source line reads "Added by you").
export { ExternalSearchPanel, type ExternalSearchPanelProps, ExternalSearchLinks, readCnMeta, withOwnImport } from './cn';
// Parity wave (PAR-8): the listing facts of the contract handed to the slot
// (original publisher, original link, last verified), the list header that
// says where the postings come from, and where the apply button leads.
export { CnFeedSources, CN_RECRUITER_BANK_NAME, type CnFeedSourcesProps, cnApplyCopy, type CnApplyCopy, withListing } from './cn';
