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
//
// WP-75 removed the dead slices (queue, activity, integrations, onboarding,
// discover, jobs, insights, saved searches, LinkedIn URL config) here and in
// `lib/api/v2/_real.ts`, in lockstep.

import { RoboApiError } from '../api/client';
import {
  FIXTURE_AI_REWRITES,
  FIXTURE_GOAL,
  FIXTURE_JOBS,
  FIXTURE_MOCK_CATALOG,
  FIXTURE_MOCK_QUESTIONS,
  FIXTURE_MOCK_SCORE,
  FIXTURE_MOCK_SESSIONS,
  FIXTURE_PREFERENCE_OPTIONS,
  FIXTURE_PREFERENCES,
  FIXTURE_RESUME_COACH_TIPS,
  FIXTURE_RESUMES,
  FIXTURE_SKILL_SUGGESTIONS,
  FIXTURE_SUMMARY_REWRITES,
  FIXTURE_TAILOR_DIFF,
  FIXTURE_TRACKER,
} from '../fixtures';
import type {
  GoalGetResponse,
  GoalUpsertBody,
  GoalUpsertResponse,
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
  RACareerGoal,
  RAJob,
  RAJobListItem,
  RAJobMatchScoreView,
  RAPreferences,
  RAResumeKind,
  RAResumeVariant,
  RAResumeVariantSummary,
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
  LinkedInImportArgs,
  ResumeRewriteBody,
  ResumeRewriteResponse,
  ResumeTailorDiffBody,
  ResumeTailorDiffResponse,
  ResumeTailorApplyBody,
  ResumeTailorApplyResponse,
  SearchQuery,
  SearchRunParams,
  SearchRunResponse,
  TrackerBulkBody,
  TrackerBulkResponse,
  TrackerCreateBody,
  TrackerCreateResponse,
  TrackerGetResponse,
  TrackerListParams,
  TrackerListResponse,
  TrackerPatchBody,
  TrackerPatchResponse,
  // ── First-run setup (two steps) ──
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
  /** key = `${userId}:${jobId}:${resumeVariantId}`. Nothing writes it since
   *  WP-75 removed `jobs.score`; search/resume readers treat it as empty. */
  matchScores: Map<string, RAJobMatchScoreView>;
  /** Extended preferences — single mutable blob, like `goal`. */
  preferences: RAPreferences;
}

let store: StubStore | null = null;

function getStore(): StubStore {
  if (store) return store;
  store = {
    goal: structuredClone(FIXTURE_GOAL),
    jobs: structuredClone(FIXTURE_JOBS),
    tracker: structuredClone(FIXTURE_TRACKER),
    resumes: structuredClone(FIXTURE_RESUMES),
    matchScores: new Map(),
    preferences: structuredClone(FIXTURE_PREFERENCES),
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
      if (!body.targetJobId && !body.jdText && !body.targetCompany?.trim()) {
        throw new RoboApiError('targetJobId, jdText or targetCompany is required', {
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
      } else {
        // Manual target / pasted job post — mirror the backend's naming.
        diff.jobId = null;
        diff.companyName = body.targetCompany?.trim() || 'Pasted job post';
        diff.roleTitle = body.targetTitle?.trim() || 'Target role';
      }
      return {
        diff,
        tailoredResumeMarkdown: resume.resumeMarkdown,
        citationGuardPassed: true,
      };
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
};
