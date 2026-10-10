// hooks/feed — the job feed's hooks (WP-33). Other areas import from here only
// (TASK_PLAN.md §2.1 rule 4). The Assistant (WP-51) calls
// `noteAssistantFilterChange()` after the user confirmed a filter change.

export { feedKeys, type FeedFitView, type FeedListKeyInput } from './keys';
export { useFeed, flattenFeedPages, type FeedListState, type UseFeedParams } from './useFeed';
export { useJobsBadge, jobsBadgeFrom } from './useJobsBadge';
export { useImpressions, IMPRESSION_BATCH, IMPRESSION_FLUSH_MS } from './useImpressions';
export { useIsDesktop, SPLIT_VIEW_QUERY } from './useIsDesktop';
export {
  useCalibration,
  useSkillsCheckData,
  useSeenCounter,
  noteAssistantFilterChange,
  clearAssistantFilterChange,
  useAssistantFilterChange,
  sameLocalDay,
  within,
  RATING_AFTER_CARDS,
  RATING_DISMISS_KEY,
  SKILLS_DISMISS_KEY,
  SKILLS_QUIET_DAYS,
  type AssistantFilterChange,
  type CalibrationState,
} from './useCalibration';
export { useExplore, useNlQuery } from './useExplore';
export { opsToPatch, applyPatchPreview, relaxPatch, type FilterOp } from './filterOps';
