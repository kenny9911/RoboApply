// components/features/market/types.ts — shared props of the market slots
// (TASK_PLAN.md R-21; CN_TW_LAUNCH_PLAN.md §4.1(3)).

/**
 * Per-market card lines from the server's `marketHooks.cardMeta()`
 * (server/src/features/jobs/marketHooks.ts), keyed by hook set id:
 * `cn` (WP-41, GoApply recruitment-info fields) and `ats_public` (WP-42,
 * Taiwan public job boards). Values are the hook's own shape.
 */
export type MarketCardMeta = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

export interface MarketJobMetaProps {
  jobId: string;
  /** `cardMeta` for this job; null/undefined when the server sent none. */
  meta: MarketCardMeta | null | undefined;
  /** 'card' = one compact line in the feed; 'detail' = the job page block. */
  variant: 'card' | 'detail';
}

/** What MarketJobMeta hands to a market's own component. */
export type MarketJobMetaSlotProps = MarketJobMetaProps;
