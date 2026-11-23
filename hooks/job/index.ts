// hooks/job — job detail data hooks (WP-34). Actions (save, apply, undo,
// share, ask, tailor, practice) live in hooks/shared/useJobActions.
export { jobKeys, useJob, useSimilarJobs, useCompanyNews, useCompanyJobs } from './useJob';
export { shouldAskBeforeApply, useApplyIntercept } from './useApplyIntercept';
export { useAddToReady } from './useAddToReady';
