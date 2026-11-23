// hooks/feed — the job feed's hooks (WP-33). Other areas import from here only
// (TASK_PLAN.md §2.1 rule 4). The Assistant (WP-51) calls
// `noteAssistantFilterChange()` after the user confirmed a filter change.

export {
  noteAssistantFilterChange,
  clearAssistantFilterChange,
} from './useCalibration';
export { opsToPatch, applyPatchPreview } from './filterOps';
export { usePayCheck, type PayCheckAsk } from './usePayCheck';
