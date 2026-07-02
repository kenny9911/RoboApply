// lib/stub/raV2.stub.ts
//
// In-memory implementation of `RaV2Api` for Wave-2 stub-first dev. F2-F5
// build their pages against this — no backend required.
//
// Architectural shape:
//
//   `stubStore` holds mutable state. Initial values are deep-cloned from
//   the fixture modules on FIRST READ so mutations don't bleed into the
//   imported constants (matters for Vitest re-runs / HMR).
//
//   Every method awaits `delay(profile)` so the UI's loading states fire.
//   The latency profile mirrors what the real backend will feel like:
//     - 'fast'      = 60–120ms  (GETs, cheap server work)
//     - 'slow'      = 120–200ms (mutations, single-row writes)
//     - 'very_slow' = 800–1600ms (LLM-backed: scoring, tailoring, refresh)
//
//   All errors are thrown as `RoboApiError` so the call site can
//   .code-switch the same way it will against the real backend.
//
// Wave-4 swap procedure (per `03-frontend-architecture.md §5.8`):
//   1. Flip `NEXT_PUBLIC_USE_STUB_API=false`.
//   2. `lib/api/v2/_real.ts` becomes the active surface.
//   3. This file stays — it's the executable contract spec.

import { RoboApiError } from '../api/client';
import {
  FIXTURE_ACTIVITY,
  FIXTURE_AGENT_STATS,
  FIXTURE_AI_REWRITES,
  FIXTURE_GOAL,
  FIXTURE_INSIGHT,
  FIXTURE_INTEGRATIONS,
  FIXTURE_JOBS,
  FIXTURE_KEYWORDS,
  FIXTURE_MOCK_CATALOG,
  FIXTURE_MOCK_QUESTIONS,
  FIXTURE_MOCK_SCORE,
  FIXTURE_MOCK_SESSIONS,
  FIXTURE_PREFERENCE_OPTIONS,
  FIXTURE_PREFERENCES,
  FIXTURE_QUEUE,
  FIXTURE_RESUME_COACH_TIPS,
  FIXTURE_RESUMES,
  FIXTURE_SAVED_SEARCHES,
  FIXTURE_SKILL_SUGGESTIONS,
  FIXTURE_SUMMARY_REWRITES,
  FIXTURE_TAILOR_DIFF,
  FIXTURE_TRACKER,
} from '../fixtures';
import type {
  ActivityFeedParams,
  ActivityFeedResponse,
  AgentStatsResponse,
  GoalGetResponse,
  GoalUpsertBody,
  GoalUpsertResponse,
  InsightsRefreshResponse,
  InsightsWeeklyParams,
  InsightsWeeklyResponse,
  IntegrationResponse,
  IntegrationsListResponse,
  JobApplyBody,
  JobApplyResponse,
  JobGetParams,
  JobGetResponse,
  JobSaveResponse,
  JobScoreBody,
  JobScoreResponse,
  MockCatalogResponse,
  MockNextTurnBody,
  MockNextTurnResponse,
  MockRecentSessionsResponse,
  MockScoreResponse,
  MockStartBody,
  MockStartResponse,
  PreferencesGetResponse,
  PreferencesUpdateBody,
  PreferencesUpdateResponse,
  QueueItemResponse,
  QueueListResponse,
  QueueUpdateCoverBody,
  RAActivityDay,
  RACareerGoal,
  RACareerInsight,
  RAIntegration,
  RAIntegrationProvider,
  RAJob,
  RAJobListItem,
  RAJobMatchScoreView,
  RAPreferences,
  RAQueueItem,
  RAResumeKind,
  RAResumeVariant,
  RAResumeVariantSummary,
  RASavedSearch,
  RATrackerEntryView,
  RATrackerStatus,
  RaV2Api,
  ResumeCoachTipsResponse,
  ResumeCreateBody,
  ResumeCreateResponse,
  ResumeGetResponse,
  ResumeListResponse,
  ResumePatchBody,
  ResumePatchResponse,
  LinkedInImportConfigResponse,
  LinkedInImportArgs,
  ResumeRewriteBody,
  ResumeRewriteResponse,
  ResumeTailorDiffBody,
  ResumeTailorDiffResponse,
  ResumeTailorApplyBody,
  ResumeTailorApplyResponse,
  SearchListSavedResponse,
  SearchQuery,
  SearchRunParams,
  SearchRunResponse,
  SearchSaveQueryResponse,
  TrackerBulkBody,
  TrackerBulkResponse,
  TrackerCreateBody,
  TrackerCreateResponse,
  TrackerGetResponse,
  TrackerListParams,
  TrackerListResponse,
  TrackerPatchBody,
  TrackerPatchResponse,
  // ── Onboarding Chat v4 ──
  IngestRow,
  OnboardingBootstrapBody,
  OnboardingBootstrapResponse,
  OnboardingCompleteBody,
  OnboardingCompleteResponse,
  OnboardingDraftPreferences,
  OnboardingJobCard,
  OnboardingPassBody,
  OnboardingPassResponse,
  OnboardingSessionResponse,
  OnboardingSkipBody,
  OnboardingSkipResponse,
  OnboardingTranscriptMessage,
  RAOnboardingState,
  RAOnboardingStreamEvent,
} from '../api/v2/types';

// ─────────────────────────────────────────────────────────────────────
// Latency simulation
// ─────────────────────────────────────────────────────────────────────

type LatencyProfile = 'fast' | 'slow' | 'very_slow';

const LATENCY_RANGES: Record<LatencyProfile, [number, number]> = {
  fast: [60, 120],
  slow: [120, 200],
  very_slow: [800, 1600],
};

function delay(profile: LatencyProfile = 'fast'): Promise<void> {
  const [min, max] = LATENCY_RANGES[profile];
  const ms = Math.round(min + Math.random() * (max - min));
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────────────
// Shared store (lazy-init from fixtures)
// ─────────────────────────────────────────────────────────────────────

interface StubStore {
  goal: RACareerGoal | null;
  jobs: RAJob[];
  tracker: RATrackerEntryView[];
  resumes: RAResumeVariant[];
  savedSearches: RASavedSearch[];
  insightsByWeek: Map<string, RACareerInsight>;
  /** key = `${userId}:${jobId}:${resumeVariantId}` */
  matchScores: Map<string, RAJobMatchScoreView>;
  /** last `insights.refresh()` timestamp per user, for 1/hour throttling */
  lastInsightRefreshAt: Map<string, number>;
  // ── V3 mutable state ──
  /** Review queue — `send`/`skip` flip status, `updateCover` overwrites. */
  queue: RAQueueItem[];
  /** Connected services — `connect`/`disconnect` flip `connected` + account. */
  integrations: RAIntegration[];
  /** Extended preferences — single mutable blob, like `goal`. */
  preferences: RAPreferences;
  /** Onboarding Chat v4 — the single active fake session (null = none). */
  onboarding: StubOnboardingSession | null;
}

/** Mirrors the server-side `RAOnboardingSession` row closely enough for the
 *  S0→chat→complete loop to run end-to-end against the stub. */
interface StubOnboardingSession {
  sessionId: string;
  state: RAOnboardingState;
  resumeVariantId: string | null;
  transcript: OnboardingTranscriptMessage[];
  draftPreferences: OnboardingDraftPreferences;
  capturedFields: string[];
  chips: string[];
  openingPrompt: string;
  ingestRows: IngestRow[];
  surfacedJobs: OnboardingJobCard[];
  passedJobIds: string[];
  turnCount: number;
  recommendationRounds: number;
}

let store: StubStore | null = null;

function getStore(): StubStore {
  if (store) return store;
  store = {
    goal: structuredClone(FIXTURE_GOAL),
    jobs: structuredClone(FIXTURE_JOBS),
    tracker: structuredClone(FIXTURE_TRACKER),
    resumes: structuredClone(FIXTURE_RESUMES),
    savedSearches: structuredClone(FIXTURE_SAVED_SEARCHES),
    insightsByWeek: new Map([
      [FIXTURE_INSIGHT.weekStartUtc, structuredClone(FIXTURE_INSIGHT)],
    ]),
    matchScores: new Map(),
    lastInsightRefreshAt: new Map(),
    queue: structuredClone(FIXTURE_QUEUE),
    integrations: structuredClone(FIXTURE_INTEGRATIONS),
    preferences: structuredClone(FIXTURE_PREFERENCES),
    onboarding: null,
  };
  return store;
}

/** Test/devtools helper: clear the store so a fresh fixture set re-loads
 *  on the next call. Exposed for Playwright walks and Vitest setup. */
export function resetRaV2Stub(): void {
  store = null;
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

const DEMO_USER_ID = 'cm_user_demo';

function nowIso(): string {
  return new Date().toISOString();
}

function newId(prefix: string): string {
  // Deterministic enough for the demo; collision-safe within one session.
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${rand}`;
}

function makeStatusCounts(
  entries: RATrackerEntryView[],
): Record<RATrackerStatus, number> {
  const out: Record<RATrackerStatus, number> = {
    bookmarked: 0,
    applying: 0,
    applied: 0,
    interviewing: 0,
    negotiating: 0,
    accepted: 0,
    rejected: 0,
    withdrawn: 0,
  };
  for (const e of entries) out[e.status] += 1;
  return out;
}

function jobToListItem(
  job: RAJob,
  isBookmarked: boolean,
  matchScore: number | null,
): RAJobListItem {
  return {
    id: job.id,
    title: job.title,
    companyName: job.companyName,
    companyLogoUrl: job.companyLogoUrl,
    location: job.location,
    workType: job.workType,
    salaryMin: job.salaryMin,
    salaryMax: job.salaryMax,
    salaryCurrency: job.salaryCurrency,
    postedAt: job.postedAt,
    isBookmarked,
    matchScoreCached: matchScore,
  };
}

function resumeToSummary(r: RAResumeVariant, jobs: RAJob[]): RAResumeVariantSummary {
  const targetJob = r.targetJobId ? jobs.find((j) => j.id === r.targetJobId) : null;
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    targetJobId: r.targetJobId,
    targetJobTitle: targetJob?.title ?? null,
    targetJobCompany: targetJob?.companyName ?? null,
    matchScoreCached: r.matchScoreCached,
    isPrimary: r.isPrimary ?? false,
    sourceKind: r.sourceKind ?? null,
    lastEditedAt: r.lastEditedAt,
    createdAt: r.createdAt,
  };
}

function entryFromJob(
  s: StubStore,
  jobId: string,
  body: TrackerCreateBody,
  status: RATrackerStatus,
): RATrackerEntryView {
  const job = s.jobs.find((j) => j.id === jobId);
  return {
    id: newId('cm_tr'),
    userId: DEMO_USER_ID,
    jobId,
    status,
    excitementStars: body.excitementStars ?? 0,
    maxSalary: body.maxSalary ?? job?.salaryMax ?? null,
    maxSalaryCurrency: body.maxSalaryCurrency ?? job?.salaryCurrency ?? null,
    notesMarkdown: body.notesMarkdown ?? null,
    dateSaved: nowIso(),
    dateApplied: body.dateApplied ?? (status === 'applied' ? nowIso() : null),
    deadline: body.deadline ?? null,
    followUpAt: null,
    appliedVia: status === 'applied' ? 'manual' : null,
    linkedRunId: null,
    job: job
      ? {
          title: job.title,
          companyName: job.companyName,
          companyLogoUrl: job.companyLogoUrl,
          location: job.location,
          workType: job.workType,
          applyUrl: job.applyUrl,
        }
      : null,
    externalSnapshot: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}

function entryFromExternal(
  body: TrackerCreateBody,
): RATrackerEntryView {
  return {
    id: newId('cm_tr'),
    userId: DEMO_USER_ID,
    jobId: null,
    status: body.status ?? 'bookmarked',
    excitementStars: body.excitementStars ?? 0,
    maxSalary: body.maxSalary ?? null,
    maxSalaryCurrency: body.maxSalaryCurrency ?? null,
    notesMarkdown: body.notesMarkdown ?? null,
    dateSaved: nowIso(),
    dateApplied: body.dateApplied ?? null,
    deadline: body.deadline ?? null,
    followUpAt: null,
    appliedVia: null,
    linkedRunId: null,
    job: null,
    externalSnapshot: body.externalSnapshot ?? null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}

/** Deterministic synthetic match score, so the same (variantId, jobId) pair
 *  always returns the same number across calls. Range 35..98 — keeps the
 *  gauge interesting without ever bottoming out completely. */
function syntheticMatchScore(jobId: string, resumeVariantId: string): number {
  let h = 0;
  const s = `${jobId}:${resumeVariantId}`;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
  return 35 + (h % 64); // 35..98
}

function syntheticMatchExplanation(
  job: RAJob,
  resumeVariantId: string,
  score: number,
): RAJobMatchScoreView {
  const baseSkill = score - 5;
  const baseExp = score + (resumeVariantId.length % 7) - 3;
  return {
    score,
    explanation: {
      strengths: [
        `Strong overlap on the core ${job.title.split(',')[0].trim()} responsibilities`,
        'Production ML experience aligns with the team\'s stated needs',
        'Recent role at a high-growth company maps to the company stage',
      ],
      gaps: [
        score < 70
          ? 'Limited evidence of the specific domain (e.g. fintech / health) the role calls out'
          : 'Could highlight a project tightly matching the JD bullet points',
        score < 60
          ? 'Years of experience is just below the lower bound of the JD'
          : 'Consider adding one quantified outcome per recent role',
      ],
      rationale:
        `This is a ${score >= 80 ? 'strong' : score >= 60 ? 'good' : score >= 40 ? 'stretch' : 'long shot'} ` +
        `match. The resume covers the headline requirements and shows recent production experience at relevant scale. ` +
        `The biggest opportunity is to tailor the top three bullets toward the specific product surface the JD names.`,
      signals: {
        skills: Math.max(0, Math.min(100, baseSkill)),
        experience: Math.max(0, Math.min(100, baseExp)),
        location: job.workType === 'remote' ? 95 : 80,
        salary: 85,
      },
    },
    generatedAt: nowIso(),
    resumeVariantId,
    stale: false,
  };
}

function syntheticInsightForCurrentWeek(
  tracker: RATrackerEntryView[],
): RACareerInsight {
  const recent = tracker
    .filter((t) => t.status === 'applied' || t.status === 'interviewing')
    .slice(0, 2)
    .map((t) => t.id);
  return {
    id: newId('cm_in'),
    userId: DEMO_USER_ID,
    weekStartUtc: currentWeekStartUtc(),
    summaryMarkdown:
      `## Week summary\n\n` +
      `You're moving steadily through the funnel. Top priority this week: keep momentum on your active ` +
      `interviews and follow up on applications past their 5-day window.`,
    citedTrackerIds: recent,
    metrics: {
      applicationsCount: tracker.filter((t) => t.dateApplied).length,
      interviewsCount: tracker.filter((t) => t.status === 'interviewing').length,
      offerCount:
        tracker.filter((t) => t.status === 'accepted' || t.status === 'negotiating')
          .length,
      weeksToOfferEstimate: 4,
      recruiterViewsCount: 10,
      topSkillsObserved: ['LLM evaluation', 'TypeScript', 'Python'],
    },
    modelUsed: 'anthropic/claude-sonnet-4.6',
    citationGuardPassed: true,
    generatedAt: nowIso(),
    createdAt: nowIso(),
  };
}

function currentWeekStartUtc(): string {
  // Sunday-anchored UTC, matching the fixture and the doc.
  const now = new Date();
  const dow = now.getUTCDay(); // 0..6 (Sun..Sat)
  const sunday = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - dow),
  );
  return sunday.toISOString().slice(0, 10);
}

function weekRangeFor(weekStartUtc: string): { startUtc: string; endUtc: string } {
  const start = new Date(weekStartUtc + 'T00:00:00.000Z');
  const end = new Date(start.getTime() + 6 * 86_400_000);
  return {
    startUtc: start.toISOString().slice(0, 10),
    endUtc: end.toISOString().slice(0, 10),
  };
}

/** Shallow-merge a preferences patch into the stored blob, but DEEP-merge the
 *  nested record objects (`links`/`channels`/`notif`/`companyStages`/
 *  `workModes`) so a patch that touches one key doesn't clobber its siblings —
 *  mirrors the proto's `set(path, value)` semantics. Arrays + scalars replace. */
const DEEP_MERGE_PREF_KEYS = [
  'links',
  'channels',
  'notif',
  'companyStages',
  'workModes',
] as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function mergePreferences(
  current: RAPreferences,
  patch: PreferencesUpdateBody,
): RAPreferences {
  const next: RAPreferences = { ...current };
  const currentRec = current as unknown as Record<string, unknown>;
  const nextRec = next as unknown as Record<string, unknown>;
  for (const [key, val] of Object.entries(patch)) {
    if (val === undefined) continue;
    if (
      (DEEP_MERGE_PREF_KEYS as readonly string[]).includes(key) &&
      isPlainObject(val) &&
      isPlainObject(currentRec[key])
    ) {
      nextRec[key] = {
        ...(currentRec[key] as Record<string, unknown>),
        ...val,
      };
    } else {
      nextRec[key] = val;
    }
  }
  next.updatedAt = nowIso();
  return next;
}

/** Map a bullet's text to a fixture rewrite key. The proto canned rewrites for
 *  two specific bullets (b2 = the dashboard squad bullet, b4 = the weak
 *  retention bullet); anything else falls back to `__default`. We match on a
 *  short distinctive substring so the editor can pass either the raw bullet
 *  text or an id-prefixed marker. */
function pickRewriteKey(text?: string): keyof typeof FIXTURE_AI_REWRITES {
  if (!text) return '__default';
  const t = text.toLowerCase();
  if (t.includes('b4') || t.includes('worked closely with eng and design')) {
    return 'b4';
  }
  if (t.includes('b2') || t.includes('led a 4-person squad')) {
    return 'b2';
  }
  return '__default';
}

// ─────────────────────────────────────────────────────────────────────
// Search filtering — matches the documented behavior:
//   q -> substring match on title + companyName (case-insensitive)
//   location -> substring match on `location` and `locationCity`
//   workType -> exact match
//   salaryMin -> `salaryMax >= salaryMin`  (don't gate on min — we surface
//                jobs whose top of band clears the user's floor)
//   datePosted -> '7d', '30d', 'today', 'any'
//   employmentType -> exact match when set
//   sortBy -> relevance | recent | salary_desc | match_desc
// ─────────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

function matchesSearchQuery(job: RAJob, q: SearchQuery): boolean {
  if (q.q) {
    // BUG-RA-V2-03 (round 2): the stub used to require the FULL query string
    // as a substring, which dropped goal-title queries like "AI Software
    // Engineer" to zero hits. Round 1's fix tokenised and required ALL tokens
    // — but that over-corrected: a 3-token goal title meant exactly 1 of 50
    // fixture jobs matched (the Home grid collapsed to a single card). Real
    // search will rank by BM25 / trigram score; for the stub we want a soft
    // match — surface a job if ANY token hits title/company/description.
    // Short tokens ("a", "i", "of") are still dropped to avoid pure noise.
    const tokens = q.q
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length >= 2);
    if (tokens.length === 0) {
      // Only short tokens — fall back to substring match.
      const needle = q.q.toLowerCase();
      const hay = `${job.title} ${job.companyName}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    } else {
      const hay = `${job.title} ${job.companyName} ${job.description ?? ''}`.toLowerCase();
      if (!tokens.some((t) => hay.includes(t))) return false;
    }
  }
  if (q.location) {
    const needle = q.location.toLowerCase();
    const a = (job.location ?? '').toLowerCase();
    const b = (job.locationCity ?? '').toLowerCase();
    if (!a.includes(needle) && !b.includes(needle)) return false;
  }
  if (q.workType && job.workType !== q.workType) return false;
  if (
    typeof q.salaryMin === 'number' &&
    (job.salaryMax ?? -Infinity) < q.salaryMin
  ) {
    return false;
  }
  if (q.employmentType && job.employmentType !== q.employmentType) return false;
  if (q.datePosted && q.datePosted !== 'any' && job.postedAt) {
    const posted = new Date(job.postedAt).getTime();
    const ageMs = Date.now() - posted;
    const limitDays =
      q.datePosted === 'today' ? 1 : q.datePosted === '7d' ? 7 : 30;
    if (ageMs > limitDays * DAY_MS) return false;
  }
  return true;
}

function sortJobs(
  jobs: RAJob[],
  matchScoreLookup: Map<string, number | null>,
  sortBy: SearchQuery['sortBy'] = 'relevance',
): RAJob[] {
  const copy = [...jobs];
  if (sortBy === 'recent') {
    copy.sort((a, b) =>
      (b.postedAt ?? '').localeCompare(a.postedAt ?? ''),
    );
  } else if (sortBy === 'salary_desc') {
    copy.sort((a, b) => (b.salaryMax ?? 0) - (a.salaryMax ?? 0));
  } else if (sortBy === 'match_desc') {
    copy.sort((a, b) => {
      const sa = matchScoreLookup.get(a.id) ?? -1;
      const sb = matchScoreLookup.get(b.id) ?? -1;
      return sb - sa;
    });
  }
  // 'relevance' falls back to the natural fixture order (date + curation).
  return copy;
}

// ─────────────────────────────────────────────────────────────────────
// The implementation
// ─────────────────────────────────────────────────────────────────────

export const stubApi: RaV2Api = {
  // ─────────── Goal ───────────
  goal: {
    async get(): Promise<GoalGetResponse> {
      await delay('fast');
      const s = getStore();
      return { goal: s.goal ? structuredClone(s.goal) : null };
    },
    async upsert(patch: GoalUpsertBody): Promise<GoalUpsertResponse> {
      await delay('slow');
      const s = getStore();
      const next: RACareerGoal = {
        id: s.goal?.id ?? newId('cm_goal'),
        userId: DEMO_USER_ID,
        targetTitle: patch.targetTitle,
        targetDate: patch.targetDate ?? s.goal?.targetDate ?? null,
        targetSalaryMin: patch.targetSalaryMin ?? s.goal?.targetSalaryMin ?? null,
        targetSalaryMax: patch.targetSalaryMax ?? s.goal?.targetSalaryMax ?? null,
        targetSalaryCurrency:
          patch.targetSalaryCurrency ?? s.goal?.targetSalaryCurrency ?? 'USD',
        weeklyApplicationGoal:
          patch.weeklyApplicationGoal ?? s.goal?.weeklyApplicationGoal ?? 5,
        preferredLocations:
          patch.preferredLocations ?? s.goal?.preferredLocations ?? null,
        preferredWorkType:
          patch.preferredWorkType !== undefined
            ? patch.preferredWorkType
            : s.goal?.preferredWorkType ?? null,
        seniority:
          patch.seniority !== undefined ? patch.seniority : s.goal?.seniority ?? null,
        notesMarkdown: patch.notesMarkdown ?? s.goal?.notesMarkdown ?? null,
        createdAt: s.goal?.createdAt ?? nowIso(),
        updatedAt: nowIso(),
      };
      s.goal = next;
      return { goal: structuredClone(next) };
    },
  },

  // ─────────── Tracker ───────────
  tracker: {
    async list(params?: TrackerListParams): Promise<TrackerListResponse> {
      await delay('fast');
      const s = getStore();
      const statusFilter = Array.isArray(params?.status)
        ? params!.status
        : params?.status
          ? [params.status]
          : null;
      const filtered = statusFilter
        ? s.tracker.filter((e) => statusFilter.includes(e.status))
        : [...s.tracker];

      const sortBy = params?.sortBy ?? 'updated';
      const sortDir = params?.sortDir ?? 'desc';
      const dirMul = sortDir === 'asc' ? 1 : -1;
      filtered.sort((a, b) => {
        if (sortBy === 'dateApplied') {
          return ((a.dateApplied ?? '').localeCompare(b.dateApplied ?? '')) * dirMul;
        }
        if (sortBy === 'deadline') {
          return ((a.deadline ?? '').localeCompare(b.deadline ?? '')) * dirMul;
        }
        if (sortBy === 'excitement') {
          return (a.excitementStars - b.excitementStars) * dirMul;
        }
        return (a.updatedAt.localeCompare(b.updatedAt)) * dirMul;
      });

      const offset = params?.offset ?? 0;
      const limit = Math.min(params?.limit ?? 50, 200);
      const page = filtered.slice(offset, offset + limit);

      return {
        entries: structuredClone(page),
        statusCounts: makeStatusCounts(s.tracker),
        total: filtered.length,
      };
    },

    async get(id: string): Promise<TrackerGetResponse> {
      await delay('fast');
      const s = getStore();
      const entry = s.tracker.find((e) => e.id === id);
      if (!entry) {
        throw new RoboApiError('Tracker entry not found', {
          status: 404,
          code: 'not_found',
        });
      }
      return { entry: structuredClone(entry) };
    },

    async create(body: TrackerCreateBody): Promise<TrackerCreateResponse> {
      await delay('slow');
      const s = getStore();
      if (body.jobId) {
        if (s.tracker.some((e) => e.jobId === body.jobId)) {
          throw new RoboApiError('Already in tracker', {
            status: 409,
            code: 'duplicate_tracker_entry',
          });
        }
        const entry = entryFromJob(s, body.jobId, body, body.status ?? 'bookmarked');
        s.tracker.unshift(entry);
        return { entry: structuredClone(entry) };
      }
      if (body.externalSnapshot) {
        const entry = entryFromExternal(body);
        s.tracker.unshift(entry);
        return { entry: structuredClone(entry) };
      }
      throw new RoboApiError('Missing jobId or externalSnapshot', {
        status: 422,
        code: 'unknown',
      });
    },

    async patch(id: string, body: TrackerPatchBody): Promise<TrackerPatchResponse> {
      await delay('slow');
      const s = getStore();
      const entry = s.tracker.find((e) => e.id === id);
      if (!entry) {
        throw new RoboApiError('Tracker entry not found', {
          status: 404,
          code: 'not_found',
        });
      }
      if (body.status !== undefined) entry.status = body.status;
      if (body.excitementStars !== undefined) {
        entry.excitementStars = body.excitementStars;
      }
      if (body.maxSalary !== undefined) entry.maxSalary = body.maxSalary;
      if (body.maxSalaryCurrency !== undefined) {
        entry.maxSalaryCurrency = body.maxSalaryCurrency;
      }
      if (body.notesMarkdown !== undefined) {
        entry.notesMarkdown = body.notesMarkdown;
      }
      if (body.deadline !== undefined) entry.deadline = body.deadline;
      if (body.followUpAt !== undefined) entry.followUpAt = body.followUpAt;
      if (body.dateApplied !== undefined) entry.dateApplied = body.dateApplied;
      if (body.status === 'applied' && !entry.dateApplied) {
        entry.dateApplied = nowIso();
      }
      entry.updatedAt = nowIso();
      return { entry: structuredClone(entry) };
    },

    async delete(id: string): Promise<void> {
      await delay('slow');
      const s = getStore();
      const idx = s.tracker.findIndex((e) => e.id === id);
      if (idx === -1) {
        throw new RoboApiError('Tracker entry not found', {
          status: 404,
          code: 'not_found',
        });
      }
      s.tracker.splice(idx, 1);
    },

    async bulk(body: TrackerBulkBody): Promise<TrackerBulkResponse> {
      await delay('slow');
      const s = getStore();
      const updated: RATrackerEntryView[] = [];
      for (const id of body.ids) {
        const entry = s.tracker.find((e) => e.id === id);
        if (!entry) continue;
        if (body.patch.status !== undefined) entry.status = body.patch.status;
        if (body.patch.excitementStars !== undefined) {
          entry.excitementStars = body.patch.excitementStars;
        }
        if (body.patch.deadline !== undefined) entry.deadline = body.patch.deadline;
        entry.updatedAt = nowIso();
        updated.push(structuredClone(entry));
      }
      return { updated: updated.length, entries: updated };
    },
  },

  // ─────────── Search ───────────
  search: {
    async run(params?: SearchRunParams): Promise<SearchRunResponse> {
      await delay('fast');
      const s = getStore();
      const bookmarkedJobIds = new Set(
        s.tracker.filter((t) => t.jobId).map((t) => t.jobId as string),
      );
      const matchByJob = new Map<string, number | null>();
      for (const job of s.jobs) {
        // Use the highest score we have across any resume variant; fallback null.
        let best: number | null = null;
        for (const [key, sc] of s.matchScores) {
          if (key.includes(`:${job.id}:`) && (best === null || sc.score > best)) {
            best = sc.score;
          }
        }
        matchByJob.set(job.id, best);
      }
      const q: SearchQuery = {
        q: params?.q,
        location: params?.location,
        workType: params?.workType,
        salaryMin: params?.salaryMin,
        salaryCurrency: params?.salaryCurrency,
        datePosted: params?.datePosted,
        sortBy: params?.sortBy,
        employmentType: params?.employmentType,
      };
      const filtered = s.jobs.filter((j) => matchesSearchQuery(j, q));
      const sorted = sortJobs(filtered, matchByJob, q.sortBy);

      // Cursor-based pagination: cursor encodes the index offset.
      const limit = Math.min(params?.limit ?? 20, 50);
      const offset = params?.cursor ? Number.parseInt(params.cursor, 10) || 0 : 0;
      const page = sorted.slice(offset, offset + limit);
      const nextOffset = offset + limit;
      const nextCursor =
        nextOffset < sorted.length ? String(nextOffset) : null;

      const items: RAJobListItem[] = page.map((j) =>
        jobToListItem(j, bookmarkedJobIds.has(j.id), matchByJob.get(j.id) ?? null),
      );

      // Facets only on cold-load (no cursor).
      let facets: SearchRunResponse['facets'] = undefined;
      if (!params?.cursor) {
        const workType: Record<string, number> = {};
        const locationCountry: Record<string, number> = {};
        for (const j of sorted) {
          workType[j.workType] = (workType[j.workType] ?? 0) + 1;
          if (j.locationCountry) {
            locationCountry[j.locationCountry] =
              (locationCountry[j.locationCountry] ?? 0) + 1;
          }
        }
        facets = { workType, locationCountry };
      }
      return { jobs: items, nextCursor, facets };
    },

    async saveQuery(body: {
      name: string;
      query: SearchQuery;
    }): Promise<SearchSaveQueryResponse> {
      await delay('slow');
      const s = getStore();
      if (s.savedSearches.some((ss) => ss.name === body.name)) {
        throw new RoboApiError('Saved search name already taken', {
          status: 409,
          code: 'unknown',
        });
      }
      const saved: RASavedSearch = {
        id: newId('cm_ss'),
        userId: DEMO_USER_ID,
        name: body.name,
        query: structuredClone(body.query),
        lastRunAt: null,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      s.savedSearches.unshift(saved);
      return { savedSearch: structuredClone(saved) };
    },

    async listSaved(): Promise<SearchListSavedResponse> {
      await delay('fast');
      const s = getStore();
      const out = [...s.savedSearches].sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt),
      );
      return { savedSearches: structuredClone(out) };
    },

    async deleteSaved(id: string): Promise<void> {
      await delay('slow');
      const s = getStore();
      const idx = s.savedSearches.findIndex((ss) => ss.id === id);
      if (idx === -1) {
        throw new RoboApiError('Saved search not found', {
          status: 404,
          code: 'not_found',
        });
      }
      s.savedSearches.splice(idx, 1);
    },
  },

  // ─────────── Jobs ───────────
  jobs: {
    async get(id: string, params?: JobGetParams): Promise<JobGetResponse> {
      await delay('fast');
      const s = getStore();
      const job = s.jobs.find((j) => j.id === id);
      if (!job) {
        throw new RoboApiError('Job not found', {
          status: 404,
          code: 'not_found',
        });
      }
      const trackerEntry =
        s.tracker.find((t) => t.jobId === id) ?? null;
      let matchScore: RAJobMatchScoreView | null = null;
      if (params?.resumeVariantId) {
        const key = `${DEMO_USER_ID}:${id}:${params.resumeVariantId}`;
        matchScore = s.matchScores.get(key) ?? null;
      } else {
        // No specific variant requested — surface the best score (if any).
        for (const [key, sc] of s.matchScores) {
          if (key.includes(`:${id}:`)) {
            if (!matchScore || sc.score > matchScore.score) matchScore = sc;
          }
        }
      }
      const keywords = FIXTURE_KEYWORDS[id] ?? null;
      return {
        job: structuredClone(job),
        trackerEntry: trackerEntry ? structuredClone(trackerEntry) : null,
        matchScore: matchScore ? structuredClone(matchScore) : null,
        keywords: keywords ? structuredClone(keywords) : null,
      };
    },

    async apply(id: string, body: JobApplyBody): Promise<JobApplyResponse> {
      await delay('slow');
      const s = getStore();
      const job = s.jobs.find((j) => j.id === id);
      if (!job) {
        throw new RoboApiError('Job not found', {
          status: 404,
          code: 'not_found',
        });
      }
      const existing = s.tracker.find((t) => t.jobId === id);
      if (existing) {
        existing.status = 'applied';
        existing.dateApplied = existing.dateApplied ?? nowIso();
        existing.appliedVia = body.appliedVia ?? 'manual';
        existing.updatedAt = nowIso();
        return { trackerEntry: structuredClone(existing) };
      }
      const entry = entryFromJob(s, id, { jobId: id }, 'applied');
      entry.appliedVia = body.appliedVia ?? 'manual';
      s.tracker.unshift(entry);
      return { trackerEntry: structuredClone(entry) };
    },

    async save(
      id: string,
      body?: { excitementStars?: number },
    ): Promise<JobSaveResponse> {
      await delay('slow');
      const s = getStore();
      const job = s.jobs.find((j) => j.id === id);
      if (!job) {
        throw new RoboApiError('Job not found', {
          status: 404,
          code: 'not_found',
        });
      }
      const existing = s.tracker.find((t) => t.jobId === id);
      if (existing) {
        // Idempotent — bump excitement if provided but don't downgrade status.
        if (body?.excitementStars !== undefined) {
          existing.excitementStars = body.excitementStars;
        }
        existing.updatedAt = nowIso();
        return { trackerEntry: structuredClone(existing) };
      }
      const entry = entryFromJob(
        s,
        id,
        { jobId: id, excitementStars: body?.excitementStars },
        'bookmarked',
      );
      s.tracker.unshift(entry);
      return { trackerEntry: structuredClone(entry) };
    },

    async score(id: string, body: JobScoreBody): Promise<JobScoreResponse> {
      const s = getStore();
      const job = s.jobs.find((j) => j.id === id);
      if (!job) {
        throw new RoboApiError('Job not found', {
          status: 404,
          code: 'not_found',
        });
      }
      const key = `${DEMO_USER_ID}:${id}:${body.resumeVariantId}`;
      const cached = s.matchScores.get(key);
      if (cached && !body.force) {
        await delay('fast');
        return { matchScore: structuredClone(cached), cached: true };
      }
      await delay('very_slow');
      const score = syntheticMatchScore(id, body.resumeVariantId);
      const view = syntheticMatchExplanation(job, body.resumeVariantId, score);
      s.matchScores.set(key, view);
      return { matchScore: structuredClone(view), cached: false };
    },
  },

  // ─────────── Resumes ───────────
  resumes: {
    async list(params?: { kind?: RAResumeKind }): Promise<ResumeListResponse> {
      await delay('fast');
      const s = getStore();
      const active = s.resumes.filter((r) => !r.deletedAt);
      const filtered = params?.kind ? active.filter((r) => r.kind === params.kind) : active;
      const sorted = [...filtered].sort((a, b) =>
        b.lastEditedAt.localeCompare(a.lastEditedAt),
      );
      return {
        resumes: sorted.map((r) => resumeToSummary(r, s.jobs)),
      };
    },

    async create(body: ResumeCreateBody): Promise<ResumeCreateResponse> {
      const s = getStore();
      // Mirror the backend: the first résumé a user has becomes primary.
      const isFirst = s.resumes.filter((r) => !r.deletedAt).length === 0;
      if (body.kind === 'base') {
        await delay('slow');
        const created: RAResumeVariant = {
          id: newId('cm_rv'),
          userId: DEMO_USER_ID,
          name: body.name,
          kind: 'base',
          targetJobId: null,
          basedOnVariantId: null,
          templateKey: null,
          resumeMarkdown: body.resumeMarkdown,
          resumeContentHash: `sha256:${newId('h').slice(-12)}`,
          matchScoreCached: null,
          isPrimary: isFirst,
          sourceKind: 'scratch',
          lastEditedAt: nowIso(),
          createdAt: nowIso(),
          deletedAt: null,
        };
        s.resumes.unshift(created);
        return { resume: structuredClone(created) };
      }
      if (body.kind === 'from_template') {
        await delay('slow');
        const created: RAResumeVariant = {
          id: newId('cm_rv'),
          userId: DEMO_USER_ID,
          name: body.name,
          kind: 'from_template',
          targetJobId: null,
          basedOnVariantId: null,
          templateKey: body.templateKey,
          resumeMarkdown: `# Your name\n\n_Your title_ · your@email.com\n\n[Generated from the ${body.templateKey} template.]`,
          resumeContentHash: `sha256:${newId('h').slice(-12)}`,
          matchScoreCached: null,
          isPrimary: isFirst,
          sourceKind: 'template',
          lastEditedAt: nowIso(),
          createdAt: nowIso(),
          deletedAt: null,
        };
        s.resumes.unshift(created);
        return { resume: structuredClone(created) };
      }
      // tailored_for_jd: copy base + prepend a synthetic header.
      const base = s.resumes.find((r) => r.id === body.basedOnVariantId);
      if (!base) {
        throw new RoboApiError('Base variant not found', {
          status: 404,
          code: 'not_found',
        });
      }
      const targetJob = s.jobs.find((j) => j.id === body.targetJobId);
      await delay('very_slow');
      const created: RAResumeVariant = {
        id: newId('cm_rv'),
        userId: DEMO_USER_ID,
        name: body.name,
        kind: 'tailored_for_jd',
        targetJobId: body.targetJobId,
        basedOnVariantId: body.basedOnVariantId,
        templateKey: null,
        resumeMarkdown: targetJob
          ? `> Tailored for **${targetJob.companyName} — ${targetJob.title}**\n\n${base.resumeMarkdown}`
          : base.resumeMarkdown,
        resumeContentHash: `sha256:${newId('h').slice(-12)}`,
        matchScoreCached: targetJob
          ? syntheticMatchScore(targetJob.id, newId('rv-pending'))
          : null,
        isPrimary: isFirst,
        sourceKind: 'tailored',
        lastEditedAt: nowIso(),
        createdAt: nowIso(),
        deletedAt: null,
      };
      s.resumes.unshift(created);
      return { resume: structuredClone(created) };
    },

    async upload(file: File, opts?: { name?: string }): Promise<ResumeCreateResponse> {
      await delay('very_slow');
      const s = getStore();
      const isFirst = s.resumes.filter((r) => !r.deletedAt).length === 0;
      const baseName = (file.name || 'resume').replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
      const created: RAResumeVariant = {
        id: newId('cm_rv'),
        userId: DEMO_USER_ID,
        name: opts?.name?.trim() || baseName || 'My résumé',
        kind: 'base',
        targetJobId: null,
        basedOnVariantId: null,
        templateKey: null,
        resumeMarkdown: `# ${baseName || 'My résumé'}\n\n_Imported from ${file.name}. The agent will help you sharpen this in the editor._`,
        resumeContentHash: `sha256:${newId('h').slice(-12)}`,
        matchScoreCached: null,
        isPrimary: isFirst,
        sourceKind: 'upload',
        parseStatus: 'parsed',
        summary: null,
        highlight: null,
        originalFileName: file.name,
        hasOriginalFile: true,
        lastEditedAt: nowIso(),
        createdAt: nowIso(),
        deletedAt: null,
      };
      s.resumes.unshift(created);
      return { resume: structuredClone(created) };
    },

    async linkedinConfig(): Promise<LinkedInImportConfigResponse> {
      await delay('fast');
      // Stub has no enrichment provider — only the PDF-export path is offered.
      return { urlImportEnabled: false };
    },

    async importLinkedIn(args: LinkedInImportArgs): Promise<ResumeCreateResponse> {
      await delay('very_slow');
      const s = getStore();
      const isFirst = s.resumes.filter((r) => !r.deletedAt).length === 0;
      const fromFile = args.mode === 'pdf' && args.file
        ? (args.file.name || 'LinkedIn export').replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim()
        : '';
      const displayName = args.name?.trim() || fromFile || 'LinkedIn import';
      const created: RAResumeVariant = {
        id: newId('cm_rv'),
        userId: DEMO_USER_ID,
        name: displayName,
        kind: 'base',
        targetJobId: null,
        basedOnVariantId: null,
        templateKey: null,
        resumeMarkdown: `# ${displayName}\n\n_Imported from LinkedIn. The agent will help you sharpen this in the editor._`,
        resumeContentHash: `sha256:${newId('h').slice(-12)}`,
        matchScoreCached: null,
        isPrimary: isFirst,
        sourceKind: 'linkedin',
        parseStatus: 'parsed',
        summary: null,
        highlight: null,
        originalFileName: args.mode === 'pdf' && args.file ? args.file.name : null,
        hasOriginalFile: args.mode === 'pdf' && !!args.file,
        lastEditedAt: nowIso(),
        createdAt: nowIso(),
        deletedAt: null,
      };
      s.resumes.unshift(created);
      return { resume: structuredClone(created) };
    },

    async setPrimary(id: string): Promise<ResumeCreateResponse> {
      await delay('fast');
      const s = getStore();
      const resume = s.resumes.find((r) => r.id === id && !r.deletedAt);
      if (!resume) {
        throw new RoboApiError('Resume not found', { status: 404, code: 'not_found' });
      }
      for (const r of s.resumes) r.isPrimary = false;
      resume.isPrimary = true;
      return { resume: structuredClone(resume) };
    },

    async get(id: string): Promise<ResumeGetResponse> {
      await delay('fast');
      const s = getStore();
      const resume = s.resumes.find((r) => r.id === id && !r.deletedAt);
      if (!resume) {
        throw new RoboApiError('Resume not found', {
          status: 404,
          code: 'not_found',
        });
      }
      return { resume: structuredClone(resume) };
    },

    async patch(id: string, body: ResumePatchBody): Promise<ResumePatchResponse> {
      await delay('slow');
      const s = getStore();
      const resume = s.resumes.find((r) => r.id === id && !r.deletedAt);
      if (!resume) {
        throw new RoboApiError('Resume not found', {
          status: 404,
          code: 'not_found',
        });
      }
      if (body.name !== undefined) resume.name = body.name;
      if (body.resumeMarkdown !== undefined) {
        resume.resumeMarkdown = body.resumeMarkdown;
        resume.resumeContentHash = `sha256:${newId('h').slice(-12)}`;
        // Mark all match scores for this variant stale.
        for (const [key, sc] of s.matchScores) {
          if (key.endsWith(`:${id}`)) sc.stale = true;
        }
      }
      resume.lastEditedAt = nowIso();
      return { resume: structuredClone(resume) };
    },

    async delete(id: string): Promise<void> {
      await delay('slow');
      const s = getStore();
      const resume = s.resumes.find((r) => r.id === id && !r.deletedAt);
      if (!resume) {
        throw new RoboApiError('Resume not found', {
          status: 404,
          code: 'not_found',
        });
      }
      const dependents = s.tracker.filter(
        (t) => t.linkedRunId === null && t.jobId !== null,
      );
      const isOnlyBase =
        resume.kind === 'base' &&
        s.resumes.filter((r) => r.kind === 'base' && !r.deletedAt).length === 1;
      if (isOnlyBase && dependents.length > 0) {
        throw new RoboApiError('Resume still in use', {
          status: 409,
          code: 'unknown',
          payload: { code: 'in_use', details: { trackerCount: dependents.length } },
        });
      }
      resume.deletedAt = nowIso();
      // Mirror the backend: if we removed the primary, promote the next
      // most-recently-edited active résumé so exactly one primary remains.
      if (resume.isPrimary) {
        resume.isPrimary = false;
        const next = s.resumes
          .filter((r) => !r.deletedAt)
          .sort((a, b) => b.lastEditedAt.localeCompare(a.lastEditedAt))[0];
        if (next) next.isPrimary = true;
      }
    },

    // ── V3 inline AI ──
    async rewrite(
      id: string,
      body: ResumeRewriteBody,
    ): Promise<ResumeRewriteResponse> {
      const s = getStore();
      const resume = s.resumes.find((r) => r.id === id && !r.deletedAt);
      if (!resume) {
        throw new RoboApiError('Resume not found', {
          status: 404,
          code: 'not_found',
        });
      }
      if (body.mode === 'bullet') {
        await delay('very_slow');
        // Look up the proto's rewrites by a synthetic bullet id encoded in the
        // text (the editor passes the bullet text; we key off any `b2`/`b4`
        // marker, else fall back to `__default`).
        const key = pickRewriteKey(body.text);
        const action = body.action ?? 'improve';
        const map = FIXTURE_AI_REWRITES[key] ?? FIXTURE_AI_REWRITES.__default;
        return { rewrite: map[action] };
      }
      if (body.mode === 'summary') {
        await delay('very_slow');
        const labels = ['Tight', 'Numeric', 'Personality'];
        return {
          options: FIXTURE_SUMMARY_REWRITES.map((text, i) => ({
            label: labels[i] ?? `Option ${i + 1}`,
            text,
          })),
        };
      }
      // mode === 'skills'
      await delay('slow');
      return { skills: [...FIXTURE_SKILL_SUGGESTIONS] };
    },

    async tailorDiff(
      id: string,
      body: ResumeTailorDiffBody,
    ): Promise<ResumeTailorDiffResponse> {
      const s = getStore();
      const resume = s.resumes.find((r) => r.id === id && !r.deletedAt);
      if (!resume) {
        throw new RoboApiError('Resume not found', {
          status: 404,
          code: 'not_found',
        });
      }
      if (!body.targetJobId && !body.jdText) {
        throw new RoboApiError('targetJobId or jdText is required', {
          status: 422,
          code: 'unknown',
        });
      }
      await delay('very_slow');
      const diff = structuredClone(FIXTURE_TAILOR_DIFF);
      // Swap in the requested job's company/role when we can resolve it.
      if (body.targetJobId) {
        diff.jobId = body.targetJobId;
        const job = s.jobs.find((j) => j.id === body.targetJobId);
        if (job) {
          diff.companyName = job.companyName;
          diff.roleTitle = job.title;
        }
      } else if (body.jdText) {
        diff.jobId = null;
        diff.companyName = 'Pasted JD';
        diff.roleTitle = 'Target role';
      }
      return { diff, tailoredResumeMarkdown: resume.resumeMarkdown };
    },

    async tailorApply(
      id: string,
      body: ResumeTailorApplyBody,
    ): Promise<ResumeTailorApplyResponse> {
      const s = getStore();
      const base = s.resumes.find((r) => r.id === id && !r.deletedAt);
      if (!base) {
        throw new RoboApiError('Resume not found', { status: 404, code: 'not_found' });
      }
      const md = (body.tailoredResumeMarkdown ?? '').trim();
      if (md.length < 20) {
        throw new RoboApiError('tailoredResumeMarkdown is required', {
          status: 422,
          code: 'unknown',
        });
      }
      await delay('slow');
      const job = body.targetJobId ? s.jobs.find((j) => j.id === body.targetJobId) : null;
      const label = job ? `${job.companyName} — ${job.title}` : base.name;
      const created: RAResumeVariant = {
        id: newId('cm_rv'),
        userId: DEMO_USER_ID,
        name: body.name?.trim() || `Tailored — ${label}`,
        kind: 'tailored_for_jd',
        targetJobId: body.targetJobId ?? null,
        basedOnVariantId: base.id,
        templateKey: null,
        resumeMarkdown: md,
        resumeContentHash: `sha256:${newId('h').slice(-12)}`,
        matchScoreCached: null,
        isPrimary: false,
        sourceKind: 'tailored',
        lastEditedAt: nowIso(),
        createdAt: nowIso(),
        deletedAt: null,
      };
      s.resumes.unshift(created);
      return { resume: structuredClone(created) };
    },

    async coachTips(id: string): Promise<ResumeCoachTipsResponse> {
      await delay('fast');
      const s = getStore();
      const resume = s.resumes.find((r) => r.id === id && !r.deletedAt);
      if (!resume) {
        throw new RoboApiError('Resume not found', {
          status: 404,
          code: 'not_found',
        });
      }
      return { tips: structuredClone(FIXTURE_RESUME_COACH_TIPS) };
    },
  },

  // ─────────── Insights ───────────
  insights: {
    async weekly(params?: InsightsWeeklyParams): Promise<InsightsWeeklyResponse> {
      await delay('fast');
      const s = getStore();
      const weekStartUtc = params?.weekStartUtc ?? FIXTURE_INSIGHT.weekStartUtc;
      const insight = s.insightsByWeek.get(weekStartUtc) ?? null;
      const week = weekRangeFor(weekStartUtc);
      return {
        insight: insight ? structuredClone(insight) : null,
        week,
        // Stub never schedules a future generation; UI just shows "Refresh now".
        nextGenerationAt: null,
      };
    },
    async refresh(): Promise<InsightsRefreshResponse> {
      const s = getStore();
      const last = s.lastInsightRefreshAt.get(DEMO_USER_ID) ?? 0;
      const cooldownMs = 60 * 60 * 1000; // 1h
      if (Date.now() - last < cooldownMs) {
        throw new RoboApiError('Already refreshed recently', {
          status: 429,
          code: 'rate_limited',
        });
      }
      await delay('very_slow');
      const insight = syntheticInsightForCurrentWeek(s.tracker);
      s.insightsByWeek.set(insight.weekStartUtc, insight);
      s.lastInsightRefreshAt.set(DEMO_USER_ID, Date.now());
      return { insight: structuredClone(insight) };
    },
  },

  // ─────────── Queue (V3) ───────────
  queue: {
    async list(): Promise<QueueListResponse> {
      await delay('fast');
      const s = getStore();
      const pending = s.queue.filter((q) => q.status === 'pending');
      return {
        items: structuredClone(pending),
        pendingCount: pending.length,
      };
    },

    async send(id: string): Promise<QueueItemResponse> {
      await delay('slow');
      const s = getStore();
      const item = s.queue.find((q) => q.id === id);
      if (!item) {
        throw new RoboApiError('Queue item not found', {
          status: 404,
          code: 'not_found',
        });
      }
      item.status = 'sent';
      item.updatedAt = nowIso();
      return { item: structuredClone(item) };
    },

    async skip(id: string): Promise<QueueItemResponse> {
      await delay('slow');
      const s = getStore();
      const item = s.queue.find((q) => q.id === id);
      if (!item) {
        throw new RoboApiError('Queue item not found', {
          status: 404,
          code: 'not_found',
        });
      }
      item.status = 'skipped';
      item.updatedAt = nowIso();
      return { item: structuredClone(item) };
    },

    async updateCover(
      id: string,
      body: QueueUpdateCoverBody,
    ): Promise<QueueItemResponse> {
      await delay('slow');
      const s = getStore();
      const item = s.queue.find((q) => q.id === id);
      if (!item) {
        throw new RoboApiError('Queue item not found', {
          status: 404,
          code: 'not_found',
        });
      }
      if (body.coverLetterMarkdown.length > 6000) {
        throw new RoboApiError('Cover letter too long', {
          status: 422,
          code: 'unknown',
        });
      }
      item.coverLetterMarkdown = body.coverLetterMarkdown;
      item.updatedAt = nowIso();
      return { item: structuredClone(item) };
    },
  },

  // ─────────── Activity (V3) ───────────
  activity: {
    async feed(params?: ActivityFeedParams): Promise<ActivityFeedResponse> {
      await delay('fast');
      const days = params?.days ?? 7;
      const cutoff = Date.now() - days * DAY_MS;
      const filtered: RAActivityDay[] = FIXTURE_ACTIVITY.filter((d) => {
        const dayMs = new Date(d.dateUtc + 'T00:00:00.000Z').getTime();
        return dayMs >= cutoff;
      });
      return { days: structuredClone(filtered) };
    },

    async orbStats(): Promise<AgentStatsResponse> {
      await delay('fast');
      const s = getStore();
      // Derive the few fields that should stay consistent with live mutations
      // (sending a queue item shrinks `inQueue`); the rest come from the fixture.
      const inQueue = s.queue.filter((q) => q.status === 'pending').length;
      const stats = {
        ...structuredClone(FIXTURE_AGENT_STATS),
        inQueue,
      };
      return { stats };
    },
  },

  // ─────────── Mock interview (V3) ───────────
  mock: {
    async catalog(): Promise<MockCatalogResponse> {
      await delay('fast');
      return { catalog: structuredClone(FIXTURE_MOCK_CATALOG) };
    },

    async recentSessions(): Promise<MockRecentSessionsResponse> {
      await delay('fast');
      return { sessions: structuredClone(FIXTURE_MOCK_SESSIONS) };
    },

    async start(body: MockStartBody): Promise<MockStartResponse> {
      await delay('slow');
      // Validate the interviewer/type exist in the catalog (best-effort).
      const okInterviewer = FIXTURE_MOCK_CATALOG.interviewers.some(
        (i) => i.id === body.interviewerId,
      );
      const okType = FIXTURE_MOCK_CATALOG.types.some((t) => t.id === body.typeId);
      if (!okInterviewer || !okType) {
        throw new RoboApiError('Unknown interviewer or interview type', {
          status: 422,
          code: 'unknown',
        });
      }
      return {
        sessionId: newId('cm_msess'),
        questions: FIXTURE_MOCK_QUESTIONS.map((q) => ({
          q: q.q,
          hint: q.hint,
          coachTip: structuredClone(q.coachTip),
        })),
      };
    },

    async nextTurn(body: MockNextTurnBody): Promise<MockNextTurnResponse> {
      // 'fast'..'slow' — feels like the interviewer is thinking.
      await delay(Math.random() < 0.5 ? 'fast' : 'slow');
      const total = FIXTURE_MOCK_QUESTIONS.length;
      const currentIdx = body.questionIndex;
      const nextIndex = currentIdx + 1 < total ? currentIdx + 1 : null;
      const current = FIXTURE_MOCK_QUESTIONS[currentIdx];

      // Echo the canned sample transcript for the current index when present;
      // otherwise advance with the next question prompt as an interviewer turn.
      const turns =
        current && current.sampleTranscript.length > 0
          ? structuredClone(current.sampleTranscript)
          : nextIndex !== null
            ? [{ who: 'them' as const, text: FIXTURE_MOCK_QUESTIONS[nextIndex].q }]
            : [];

      const coachTip = current ? structuredClone(current.coachTip) : null;
      return { nextIndex, turns, coachTip };
    },

    async score(sessionId: string): Promise<MockScoreResponse> {
      // It's the LLM-graded report — slowest path.
      await delay('very_slow');
      if (!sessionId) {
        throw new RoboApiError('sessionId is required', {
          status: 422,
          code: 'unknown',
        });
      }
      return structuredClone(FIXTURE_MOCK_SCORE);
    },
  },

  // ─────────── Integrations (V3) ───────────
  integrations: {
    async list(): Promise<IntegrationsListResponse> {
      await delay('fast');
      const s = getStore();
      return { integrations: structuredClone(s.integrations) };
    },

    async connect(provider: RAIntegrationProvider): Promise<IntegrationResponse> {
      await delay('slow');
      const s = getStore();
      const integration = s.integrations.find((i) => i.provider === provider);
      if (!integration) {
        throw new RoboApiError('Integration not found', {
          status: 404,
          code: 'not_found',
        });
      }
      integration.connected = true;
      integration.account = integration.account ?? 'maya@chen.io';
      return { integration: structuredClone(integration) };
    },

    async disconnect(
      provider: RAIntegrationProvider,
    ): Promise<IntegrationResponse> {
      await delay('slow');
      const s = getStore();
      const integration = s.integrations.find((i) => i.provider === provider);
      if (!integration) {
        throw new RoboApiError('Integration not found', {
          status: 404,
          code: 'not_found',
        });
      }
      integration.connected = false;
      integration.account = null;
      return { integration: structuredClone(integration) };
    },
  },

  // ─────────── Preferences (V3) ───────────
  preferences: {
    async get(): Promise<PreferencesGetResponse> {
      await delay('fast');
      const s = getStore();
      return {
        preferences: structuredClone(s.preferences),
        options: structuredClone(FIXTURE_PREFERENCE_OPTIONS),
      };
    },

    async update(
      body: PreferencesUpdateBody,
    ): Promise<PreferencesUpdateResponse> {
      await delay('slow');
      const s = getStore();
      s.preferences = mergePreferences(s.preferences, body);
      return { preferences: structuredClone(s.preferences) };
    },
  },

  // ─────────── Onboarding Chat v4 ───────────
  onboarding: {
    async bootstrap(
      body: OnboardingBootstrapBody,
    ): Promise<OnboardingBootstrapResponse> {
      await delay('slow');
      const s = getStore();
      const variant = s.resumes.find(
        (r) => r.id === body.resumeVariantId && !r.deletedAt,
      );
      if (!variant) {
        throw new RoboApiError('Resume variant not found', {
          status: 404,
          code: 'not_found',
        });
      }
      const ingestRows = buildStubIngestRows(variant);
      const headline =
        variant.resumeMarkdown.match(/^#\s+(.+)$/m)?.[1]?.trim() ||
        variant.name;
      const session: StubOnboardingSession = {
        sessionId: newId('cm_obs'),
        state: 'greeting',
        resumeVariantId: variant.id,
        transcript: [],
        draftPreferences: {},
        capturedFields: [],
        chips: [
          'Senior roles like my last one',
          'Remote-first only',
          'Open to contract work',
          'Show me jobs now',
        ],
        openingPrompt:
          "I'm exploring senior roles that build on my background — ideally remote-friendly.",
        ingestRows,
        surfacedJobs: [],
        passedJobIds: [],
        turnCount: 0,
        recommendationRounds: 0,
      };
      s.onboarding = session;
      return {
        sessionId: session.sessionId,
        state: session.state,
        returning: false,
        resumeVariant: { id: variant.id, name: variant.name },
        ingestRows: structuredClone(ingestRows),
        greeting: `Nice to meet you — I just read **${headline}**. Here's what I picked up. Tell me what you're hunting and I'll start lining up matches.`,
        openingPrompt: session.openingPrompt,
        chips: [...session.chips],
      };
    },

    async getSession(): Promise<OnboardingSessionResponse> {
      await delay('fast');
      const s = getStore();
      if (!s.onboarding) {
        throw new RoboApiError('No active onboarding session', {
          status: 404,
          code: 'no_active_session',
        });
      }
      const o = s.onboarding;
      return structuredClone({
        sessionId: o.sessionId,
        state: o.state,
        resumeVariantId: o.resumeVariantId,
        transcript: o.transcript,
        draftPreferences: o.draftPreferences,
        capturedFields: o.capturedFields,
        chips: o.chips,
        ...(o.turnCount === 0 ? { openingPrompt: o.openingPrompt } : {}),
        ingestRows: o.ingestRows,
        surfacedJobs: o.surfacedJobs,
        passedJobIds: o.passedJobIds,
        turnCount: o.turnCount,
        recommendationRounds: o.recommendationRounds,
      });
    },

    async complete(
      body: OnboardingCompleteBody,
    ): Promise<OnboardingCompleteResponse> {
      await delay('slow');
      const s = getStore();
      const o = s.onboarding;
      const draft = o?.draftPreferences ?? {};
      // Goal upsert — server-side targetTitle derivation (no client split hack).
      const prev = s.goal;
      s.goal = {
        id: prev?.id ?? newId('cm_goal'),
        userId: DEMO_USER_ID,
        targetTitle: draft.targetRoles?.[0] ?? prev?.targetTitle ?? 'My next role',
        targetDate: prev?.targetDate ?? null,
        targetSalaryMin: draft.salary?.min ?? prev?.targetSalaryMin ?? null,
        targetSalaryMax: draft.salary?.max ?? prev?.targetSalaryMax ?? null,
        targetSalaryCurrency:
          draft.salary?.currency ?? prev?.targetSalaryCurrency ?? 'USD',
        weeklyApplicationGoal: prev?.weeklyApplicationGoal ?? 5,
        preferredLocations: prev?.preferredLocations ?? null,
        preferredWorkType: draft.workModes?.[0] ?? prev?.preferredWorkType ?? null,
        seniority: prev?.seniority ?? null,
        notesMarkdown: prev?.notesMarkdown ?? null,
        createdAt: prev?.createdAt ?? nowIso(),
        updatedAt: nowIso(),
      };
      // Sparse preferences flush — only conversation-captured keys.
      s.preferences = mergePreferences(s.preferences, {
        aggressiveness: body.aggressiveness,
        huntActive: true,
        dailyCap: 10,
        ...(o?.resumeVariantId ? { defaultResumeId: o.resumeVariantId } : {}),
        ...(draft.industriesTarget ? { industriesTarget: draft.industriesTarget } : {}),
        ...(draft.industriesAvoid ? { industriesAvoid: draft.industriesAvoid } : {}),
        ...(draft.locations?.cities ? { cities: draft.locations.cities } : {}),
        ...(draft.mustHaves ? { mustHaves: draft.mustHaves } : {}),
        ...(draft.dealbreakers ? { dealbreakers: draft.dealbreakers } : {}),
      });
      s.onboarding = null;
      return {
        goal: structuredClone(s.goal),
        preferences: structuredClone(s.preferences),
      };
    },

    async skip(_body?: OnboardingSkipBody): Promise<OnboardingSkipResponse> {
      await delay('fast');
      const s = getStore();
      s.onboarding = null;
      return { skipped: true };
    },

    async pass(body: OnboardingPassBody): Promise<OnboardingPassResponse> {
      await delay('fast');
      const s = getStore();
      const o = s.onboarding;
      if (!o || !o.surfacedJobs.some((j) => j.id === body.jobId)) {
        throw new RoboApiError('Job not surfaced in this session', {
          status: 404,
          code: 'not_found',
        });
      }
      if (!o.passedJobIds.includes(body.jobId)) {
        o.passedJobIds.push(body.jobId);
      }
      return { passed: true };
    },
  },
};

// ─────────────────────────────────────────────────────────────────────
// Onboarding Chat v4 — fake NDJSON stream
// ─────────────────────────────────────────────────────────────────────

/** Deterministic ingest rows derived from the chosen variant — real values
 *  from the fixture markdown, never canned persona data. */
function buildStubIngestRows(variant: RAResumeVariant): IngestRow[] {
  const heading = variant.resumeMarkdown.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const firstParagraph = variant.resumeMarkdown
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith('#'));
  const rows: IngestRow[] = [
    {
      id: 'identity',
      kind: 'identity',
      label: 'Identity',
      value: heading || variant.name,
    },
  ];
  if (variant.summary || firstParagraph) {
    rows.push({
      id: 'summary',
      kind: 'summary',
      label: 'Summary',
      value: (variant.summary ?? firstParagraph ?? '').slice(0, 120),
    });
  }
  rows.push({
    id: 'imported',
    kind: 'imported',
    label: 'Imported',
    value: `Imported ${variant.name}`,
  });
  return rows;
}

/** Map a fixture `RAJob` to an onboarding card. */
function jobToOnboardingCard(
  job: RAJob,
  matchScore: number,
  external: boolean,
): OnboardingJobCard {
  return {
    id: job.id,
    title: job.title,
    companyName: job.companyName,
    companyLogoUrl: job.companyLogoUrl,
    location: job.location,
    workType: job.workType,
    salaryMin: job.salaryMin,
    salaryMax: job.salaryMax,
    salaryCurrency: job.salaryCurrency,
    postedAt: job.postedAt,
    isBookmarked: false,
    matchScoreCached: matchScore,
    matchScore,
    whyMatched: `Strong overlap with your background — **${job.title}** at ${job.companyName} lines up with your recent experience.`,
    source: external ? 'jsearch' : 'internal',
    ...(external ? { sourcePublisher: 'LinkedIn', applyUrl: job.applyUrl } : {}),
    isExternal: external,
  };
}

const STUB_STREAM_TICK_MS = 5;

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, STUB_STREAM_TICK_MS));
}

/**
 * Shape-identical fake of `POST /onboarding/chat/stream` for stub-mode dev
 * and page tests. Canonical sequence: session → prefs-update → text-delta×3
 * → chips → done; a message that asks for jobs (or the `show_jobs`
 * quick-reply) interleaves status×3 → job-cards → state recommend first.
 * Consumed by `hooks/useOnboardingChat.ts` under NEXT_PUBLIC_USE_STUB_API.
 */
export async function* onboardingStreamFake(
  sessionId: string,
  message: string,
  quickReplyId?: string,
): AsyncGenerator<RAOnboardingStreamEvent> {
  const s = getStore();
  const o = s.onboarding;
  if (!o || o.sessionId !== sessionId) {
    yield {
      type: 'error',
      code: 'no_active_session',
      message: 'No active onboarding session',
    };
    return;
  }

  o.transcript.push({ role: 'user', content: message, at: nowIso() });
  const wantsJobs =
    quickReplyId === 'show_jobs' || /\bjobs?\b|職缺|职位|求人/i.test(message);
  const wantsWrap =
    /\b(done|finish|wrap|that's all)\b/i.test(message) || o.turnCount >= 6;

  yield { type: 'session', sessionId: o.sessionId, state: o.state };
  await tick();

  // Deterministic fake capture: remote intent is the one cue we honor so the
  // tray visibly reacts during demos/tests.
  if (quickReplyId !== 'no_preference' && /remote/i.test(message)) {
    o.draftPreferences = { ...o.draftPreferences, workModes: ['remote'] };
    if (!o.capturedFields.includes('workModes')) {
      o.capturedFields.push('workModes');
    }
    yield {
      type: 'prefs-update',
      draft: structuredClone(o.draftPreferences),
      captured: ['workModes'],
      unconfirmed: [],
    };
    await tick();
  }

  let reply: string;
  if (wantsJobs) {
    yield { type: 'status', key: 'searching_internal' };
    await tick();
    yield { type: 'status', key: 'searching_external' };
    await tick();
    yield { type: 'status', key: 'scoring' };
    await tick();
    const cards = [
      jobToOnboardingCard(s.jobs[0], 88, false),
      jobToOnboardingCard(s.jobs[1], 82, false),
      jobToOnboardingCard(s.jobs[2], 76, false),
      jobToOnboardingCard(s.jobs[3], 74, true),
      jobToOnboardingCard(s.jobs[4], 71, true),
    ];
    o.surfacedJobs.push(...structuredClone(cards));
    o.recommendationRounds += 1;
    o.state = 'recommend';
    yield { type: 'job-cards', jobs: cards };
    await tick();
    yield { type: 'state', state: 'recommend' };
    await tick();
    reply =
      'Here are five roles worth a look — a mix from our index and fresh external postings. Save the ones that land, pass on the rest, and tell me what to tighten.';
  } else if (wantsWrap) {
    o.state = 'wrap';
    yield { type: 'state', state: 'wrap' };
    await tick();
    reply =
      "Great — your preferences are saved and your saved jobs are in the tracker. One last thing: how hands-on should I be with applications?";
    yield {
      type: 'quick-replies',
      options: [
        { id: 'manual', label: 'I review everything' },
        { id: 'balanced', label: 'Balanced' },
        { id: 'aggressive', label: 'Full auto' },
      ],
    };
    await tick();
  } else {
    o.state = 'elicitation';
    reply =
      'Got it — noted. One quick question: any industries you want me to focus on, or avoid entirely?';
  }

  for (const piece of splitIntoDeltas(reply)) {
    yield { type: 'text-delta', delta: piece };
    await tick();
  }

  if (!wantsWrap) {
    o.chips = wantsJobs
      ? ['Relax the salary floor', 'Include hybrid roles', 'Show me more']
      : ['Fintech or healthtech', 'No agencies', 'Show me jobs now'];
    yield { type: 'chips', chips: [...o.chips] };
    await tick();
    if (!wantsJobs) {
      yield {
        type: 'quick-replies',
        options: [{ id: 'no_preference', label: 'No preference' }],
      };
      await tick();
    }
  }

  o.transcript.push({ role: 'assistant', content: reply, at: nowIso() });
  o.turnCount += 1;
  yield { type: 'done', turnCount: o.turnCount };
}

/** Split a reply into 3-ish deltas so the streaming UI visibly streams. */
function splitIntoDeltas(text: string): string[] {
  const target = Math.ceil(text.length / 3);
  const out: string[] = [];
  for (let i = 0; i < text.length; i += target) {
    out.push(text.slice(i, i + target));
  }
  return out;
}
