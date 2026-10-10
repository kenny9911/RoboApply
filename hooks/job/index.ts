// hooks/job — job detail data hooks (WP-34). Actions (save, apply, undo,
// share, ask, tailor, practice) live in hooks/shared/useJobActions.
export { jobKeys, shouldRetryJob, useJob, useSimilarJobs, useCompanyNews, useCompanyJobs } from './useJob';
export { APPLY_INTERCEPT_NEVER, applyInterceptKey, shouldAskBeforeApply, useApplyIntercept, type ApplyIntercept } from './useApplyIntercept';
export { useAddToReady, type AddToReadyStatus } from './useAddToReady';
