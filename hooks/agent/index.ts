// hooks/agent — Ready to apply hooks (WP-53). The page and the nav badge
// import from here; other areas use only `useReadyBadge` (through
// hooks/shared/navBadges) and hooks/job's `useAddToReady`.

export { agentKeys } from './keys';
export * from './adapters';
export {
  PREPARING_POLL_MS,
  aiInProposals,
  invalidateReady,
  isUnavailable,
  kitsInProposals,
  queueRefetchInterval,
  shouldRetryAgent,
  sumProposals,
  useAddToList,
  useAgentSettings,
  useAgentSetup,
  useAnswerBank,
  useCalibrate,
  useCompleteSetupStep,
  useGenerateList,
  useKitActions,
  useKitAiAvailable,
  useKitDetail,
  useKitHistory,
  usePrepareKits,
  useQuestionKeys,
  useReadyQueue,
  useSaveAgentSettings,
  useSaveAnswers,
  useSuggestions,
  type KitAction,
  type PrepareQuote,
  type PrepareRunResult,
} from './useAgent';
export { readyBadgeFrom, useReadyBadge } from './useReadyBadge';
