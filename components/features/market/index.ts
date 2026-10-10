// components/features/market — the market slots (TASK_PLAN.md R-21).
// Shared UI imports these from here only (§2.1 rule 4); markets fill their
// own files: LegalFooter + AiGeneratedBadge (WP-13), PriceReference (WP-21b),
// cn/ (WP-41), tw/ (WP-42).

export { MarketJobMeta } from './MarketJobMeta';
export type { MarketCardMeta, MarketJobMetaProps, MarketJobMetaSlotProps } from './types';
export { LegalFooter, type LegalFooterProps } from './LegalFooter';
export { AiGeneratedBadge, type AiGeneratedBadgeProps } from './AiGeneratedBadge';
export { PriceReference, type PriceReferenceProps } from './PriceReference';
// Taiwan pieces other areas place (WP-42; re-exported at the Wave 3 gate):
// the 面議 note beside pay filters / job pages, and the TW card-meta reader.
export { NegotiablePayNote, TW_PAY_LAW_URL, type NegotiablePayNoteProps, CareerSourcesPanel, readTwMeta } from './tw';
