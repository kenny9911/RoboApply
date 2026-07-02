// lib/api/v2/index.ts
//
// Single entry point for the V2 API surface. F2-F5 import from this file.
// At module-load time we choose between the stub (Wave 2 default) and the
// real fetch-backed implementation (Wave 4) based on an env var. The chosen
// value is frozen for the session — we never flip mid-request.
//
//   import { raV2Api } from '@/lib/api/v2';
//   const { goal } = await raV2Api.goal.get();
//
// The flag is `NEXT_PUBLIC_USE_STUB_API`:
//   - 'true'  → stub      (Wave 2)
//   - 'false' → real      (Wave 4+)
//   - unset   → defaults to 'false' so production never silently runs against the stub
//
// Wave-4 procedure: flip the env var to 'false' and ship the real backend.
// `_real.ts` becomes active; the stub stays in the repo as the contract spec.

import { realApi } from './_real';
import { stubApi } from '../../stub/raV2.stub';
import type { RaV2Api } from './types';

// Stub is selected when:
//   1. `NEXT_PUBLIC_USE_STUB_API === 'true'` (explicit dev / demo opt-in), OR
//   2. `NODE_ENV === 'test'` — Vitest can't set env before module import, so
//      we default to stub in test runs. Tests never have a backend handy.
const useStub =
  process.env.NEXT_PUBLIC_USE_STUB_API === 'true' ||
  process.env.NODE_ENV === 'test';

export const raV2Api: RaV2Api = useStub ? stubApi : realApi;

/** Debugging / test helper. `true` when the stub layer is active. Don't
 *  branch on this in product code — the whole point of the surface is the
 *  call site doesn't know which implementation it's hitting. */
export const isStubApi: boolean = useStub;

// Re-export the typed surface from `raV2Api.ts` so call sites can do
// `import type { RaV2Api, ... } from '@/lib/api/v2'`.
export type {
  RaV2Api,
  RACareerGoal,
  RAJob,
  RAJobListItem,
  RATrackerStatus,
  RATrackerEntryView,
  RAJobMatchScoreView,
  RAResumeVariant,
  RAResumeVariantSummary,
  RAResumeKind,
  RASavedSearch,
  RACareerInsight,
  RAKeyword,
  RAKeywordImportance,
  RAWorkType,
  RAEmploymentType,
  RASortBy,
  RAAppliedVia,
  RASeniority,
  RAJobTier,
  RADatePosted,
  RASourceBoard,
  RASalaryPeriod,
  SearchQuery,
  SearchRunParams,
  GoalUpsertBody,
  TrackerListParams,
  TrackerCreateBody,
  TrackerPatchBody,
  TrackerBulkBody,
  JobGetParams,
  JobApplyBody,
  JobScoreBody,
  ResumeCreateBody,
  ResumePatchBody,
  InsightsWeeklyParams,
  GoalGetResponse,
  GoalUpsertResponse,
  TrackerListResponse,
  TrackerGetResponse,
  TrackerCreateResponse,
  TrackerPatchResponse,
  TrackerBulkResponse,
  SearchRunResponse,
  SearchSaveQueryResponse,
  SearchListSavedResponse,
  JobGetResponse,
  JobApplyResponse,
  JobSaveResponse,
  JobScoreResponse,
  ResumeListResponse,
  ResumeCreateResponse,
  ResumeGetResponse,
  ResumePatchResponse,
  LinkedInImportConfigResponse,
  LinkedInImportArgs,
  InsightsWeeklyResponse,
  InsightsRefreshResponse,
  // ── V3 enums ──
  RAQueueItemStatus,
  RAActivityKind,
  RAResumeRewriteAction,
  RAResumeRewriteMode,
  RATailorChangeKind,
  RAMockFormat,
  RAMockSpeaker,
  RAIntegrationProvider,
  RAAggressiveness,
  // ── V3 entities ──
  RAQueueCheck,
  RAQueueItem,
  RAActivityEntry,
  RAActivityDay,
  RAAgentStats,
  RAMockInterviewer,
  RAMockType,
  RAMockRoleCategory,
  RAMockCatalog,
  RAMockSessionSummary,
  RAMockTurn,
  RAMockCoachTip,
  RAIntegration,
  RAPreferences,
  RAPreferenceOptions,
  RATailorChange,
  RATailorDiff,
  RAResumeCoachTip,
  // ── V3 request shapes ──
  QueueUpdateCoverBody,
  ActivityFeedParams,
  MockStartBody,
  MockNextTurnBody,
  ResumeRewriteBody,
  ResumeTailorDiffBody,
  PreferencesUpdateBody,
  // ── V3 response shapes ──
  QueueListResponse,
  QueueItemResponse,
  ActivityFeedResponse,
  AgentStatsResponse,
  MockCatalogResponse,
  MockRecentSessionsResponse,
  MockStartResponse,
  MockNextTurnResponse,
  MockScoreResponse,
  IntegrationsListResponse,
  IntegrationResponse,
  PreferencesGetResponse,
  PreferencesUpdateResponse,
  ResumeRewriteResponse,
  ResumeTailorDiffResponse,
  ResumeCoachTipsResponse,
  // ── Onboarding Chat v4 ──
  RAOnboardingState,
  RAOnboardingStatusKey,
  RAOnboardingStreamEvent,
  RAOnboardingQuickReply,
  IngestRow,
  OnboardingDraftPreferences,
  OnboardingDraftSalary,
  OnboardingDraftLocations,
  OnboardingJobCard,
  OnboardingBootstrapBody,
  OnboardingBootstrapResponse,
  OnboardingChatStreamBody,
  OnboardingTranscriptMessage,
  OnboardingSessionResponse,
  OnboardingCompleteBody,
  OnboardingCompleteResponse,
  OnboardingSkipBody,
  OnboardingSkipResponse,
  OnboardingPassBody,
  OnboardingPassResponse,
} from './raV2Api';
