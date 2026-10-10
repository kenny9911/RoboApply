// hooks/match — fit score, fit analysis and keyword check hooks (WP-18);
// the competitiveness report (WP-77).
export { useJobFit, useRewriteFitText, isRewrittenFit, FitRewriteNotDoneError, jobFitKey, shouldRetryMatch } from './useJobFit';
export { useFitAnalysis, type FitAnalysisStatus, type UseFitAnalysis } from './useFitAnalysis';
export { useKeywordCheck, keywordCheckKey } from './useKeywordCheck';
export {
  competitivenessKey,
  useCreateCompetitiveness,
  useLatestCompetitiveness,
  type CompetitivenessRunStatus,
  type UseCreateCompetitiveness,
} from './useCompetitiveness';
