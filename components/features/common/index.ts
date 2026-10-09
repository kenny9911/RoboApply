// components/features/common — shared, area-neutral UI helpers (FND-6a).
// Cross-area imports go through this file (TASK_PLAN.md §2.1 rule 4).

export {
  MIN_SAMPLE,
  SourceNote,
  SourcedValue,
  isEstimate,
  isPublishable,
  isSuppressed,
  sourceLabelKey,
  type SourceNoteProps,
  type SourcedLike,
  type SourcedValueProps,
} from './SourceNote';
export { DEFAULT_MATCH_TIERS, FIT_TIERS, normalizeScore, tierForScore, type FitTierKey } from './fit';
export { HONESTY_KEYS, HONESTY_KINDS, type HonestyKind } from './honesty';
