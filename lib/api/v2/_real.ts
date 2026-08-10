// lib/api/v2/_real.ts
//
// Wave-4 wiring: the real `RaV2Api` implementation that hits the Express
// backend at `/api/v1/roboapply/v2/*`. Selected by `index.ts` when
// `NEXT_PUBLIC_USE_STUB_API !== 'true'` (and not in test mode).
//
// Contract: every method MUST return the same shape as `lib/stub/raV2.stub.ts`.
// Drift between the two is the bug — keep them in lockstep. The shared
// `types.ts` is the typing safety net (compile-error on drift).
//
// Auth: `roboApi` (lib/api/client.ts) attaches the `session_token` cookie
// via `credentials: 'include'` and falls back to a Bearer token from
// localStorage when the cookie is blocked.

import { roboApi, request } from '../client';
import type {
  RaV2Api,
  GoalGetResponse,
  GoalUpsertBody,
  GoalUpsertResponse,
  TrackerListParams,
  TrackerListResponse,
  TrackerGetResponse,
  TrackerCreateBody,
  TrackerCreateResponse,
  TrackerPatchBody,
  TrackerPatchResponse,
  TrackerBulkBody,
  TrackerBulkResponse,
  SearchRunParams,
  SearchRunResponse,
  SearchQuery,
  SearchSaveQueryResponse,
  SearchListSavedResponse,
  JobGetParams,
  JobGetResponse,
  JobApplyBody,
  JobApplyResponse,
  JobSaveResponse,
  JobScoreBody,
  JobScoreResponse,
  RAResumeKind,
  ResumeListResponse,
  ResumeCreateBody,
  ResumeCreateResponse,
  ResumeGetResponse,
  ResumePatchBody,
  ResumePatchResponse,
  LinkedInImportConfigResponse,
  LinkedInImportArgs,
  InsightsWeeklyParams,
  InsightsWeeklyResponse,
  InsightsRefreshResponse,
  // ── V3 surfaces (stub-now, real-later) ──
  ResumeRewriteBody,
  ResumeRewriteResponse,
  ResumeTailorDiffBody,
  ResumeTailorDiffResponse,
  ResumeTailorApplyBody,
  ResumeTailorApplyResponse,
  ResumeCoachTipsResponse,
  QueueListResponse,
  QueueItemResponse,
  QueueUpdateCoverBody,
  ActivityFeedParams,
  ActivityFeedResponse,
  AgentStatsResponse,
  MockCatalogResponse,
  MockRecentSessionsResponse,
  MockStartBody,
  MockStartResponse,
  MockNextTurnBody,
  MockNextTurnResponse,
  MockScoreResponse,
  IntegrationsListResponse,
  IntegrationResponse,
  RAIntegrationProvider,
  PreferencesGetResponse,
  PreferencesUpdateBody,
  PreferencesUpdateResponse,
  // ── First-run setup ──
  OnboardingBootstrapBody,
  OnboardingBootstrapResponse,
  OnboardingSessionResponse,
  OnboardingConfirmBody,
  OnboardingConfirmResponse,
  OnboardingSkipBody,
  OnboardingSkipResponse,
  OnboardingSeenBody,
  OnboardingSeenResponse,
  DiscoverRunBody,
  CrossBankDiscoverResponse,
} from './types';

const BASE = '/api/v1/roboapply/v2';

/** Build a `?k=v&k=v` query string from a flat object. Array values become
 *  repeated keys (`?status=a&status=b`), which is how Express parses them
 *  out of the box. `undefined` / `null` values are dropped.
 *
 *  Accepts `object | undefined` rather than `Record<string, unknown>` so
 *  callers can pass interface types (TrackerListParams etc.) without an
 *  index-signature cast. */
function qs(params?: object): string {
  if (!params) return '';
  const usp = new URLSearchParams();
  for (const [key, val] of Object.entries(params)) {
    if (val === undefined || val === null) continue;
    if (Array.isArray(val)) {
      for (const v of val) {
        if (v === undefined || v === null) continue;
        usp.append(key, String(v));
      }
    } else {
      usp.append(key, String(val));
    }
  }
  const s = usp.toString();
  return s ? `?${s}` : '';
}

/** Stable per-file token for the résumé upload's idempotency key.
 *
 *  A scanned-PDF upload parses for 45-80s, so its response is the one most
 *  likely to be lost in transit (proxy timeout, flaky mobile connection) AFTER
 *  the server committed the row. Keying on the file's own bytes means a retry —
 *  the same picked file, whether re-submitted in the same modal or picked again
 *  tomorrow — carries the key the first attempt used, so the backend can return
 *  that résumé instead of creating a second one.
 *
 *  `crypto.subtle` needs a secure context (https, or localhost in dev). Where
 *  it is unavailable we fall back to the file's identity triple, which is a
 *  weaker but still useful token; a null return simply means the upload runs
 *  without replay protection, exactly as it did before. */
async function fileIdempotencyKey(file: File): Promise<string | null> {
  const fallback = `${file.name}:${file.size}:${file.lastModified}`;
  try {
    if (!globalThis.crypto?.subtle) return fallback;
    const digest = await globalThis.crypto.subtle.digest(
      'SHA-256',
      await file.arrayBuffer(),
    );
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  } catch {
    // Unreadable file or a browser that refused the digest — the upload itself
    // will surface any real problem with the bytes.
    return fallback;
  }
}

export const realApi: RaV2Api = {
  // ── Goal ─────────────────────────────────────────────────────────
  goal: {
    get: () => roboApi.get<GoalGetResponse>(`${BASE}/goal`),
    upsert: (body: GoalUpsertBody) =>
      roboApi.put<GoalUpsertResponse>(`${BASE}/goal`, body),
  },

  // ── Tracker ──────────────────────────────────────────────────────
  tracker: {
    list: (params?: TrackerListParams) =>
      roboApi.get<TrackerListResponse>(`${BASE}/tracker${qs(params)}`),
    get: (id: string) =>
      roboApi.get<TrackerGetResponse>(`${BASE}/tracker/${encodeURIComponent(id)}`),
    create: (body: TrackerCreateBody) =>
      roboApi.post<TrackerCreateResponse>(`${BASE}/tracker`, body),
    patch: (id: string, body: TrackerPatchBody) =>
      roboApi.patch<TrackerPatchResponse>(
        `${BASE}/tracker/${encodeURIComponent(id)}`,
        body,
      ),
    delete: async (id: string) => {
      await roboApi.delete<void>(`${BASE}/tracker/${encodeURIComponent(id)}`);
    },
    bulk: (body: TrackerBulkBody) =>
      roboApi.post<TrackerBulkResponse>(`${BASE}/tracker/bulk`, body),
  },

  // ── Search ───────────────────────────────────────────────────────
  search: {
    // POST per BE2's decision (frontend stub uses `search.run({...})` and
    // sending a structured filter object via POST avoids URL-encoding the
    // optional facet args).
    run: (params?: SearchRunParams) =>
      roboApi.post<SearchRunResponse>(`${BASE}/search/run`, params ?? {}),
    saveQuery: (body: { name: string; query: SearchQuery }) =>
      roboApi.post<SearchSaveQueryResponse>(`${BASE}/search/saved`, body),
    listSaved: () =>
      roboApi.get<SearchListSavedResponse>(`${BASE}/search/saved`),
    deleteSaved: async (id: string) => {
      await roboApi.delete<void>(
        `${BASE}/search/saved/${encodeURIComponent(id)}`,
      );
    },
  },

  // ── Jobs ─────────────────────────────────────────────────────────
  jobs: {
    get: (id: string, params?: JobGetParams) =>
      roboApi.get<JobGetResponse>(
        `${BASE}/jobs/${encodeURIComponent(id)}${qs(params)}`,
      ),
    apply: (id: string, body: JobApplyBody) =>
      roboApi.post<JobApplyResponse>(
        `${BASE}/jobs/${encodeURIComponent(id)}/apply`,
        body,
      ),
    save: (id: string, body?: { excitementStars?: number }) =>
      roboApi.post<JobSaveResponse>(
        `${BASE}/jobs/${encodeURIComponent(id)}/save`,
        body ?? {},
      ),
    score: (id: string, body: JobScoreBody) =>
      roboApi.post<JobScoreResponse>(
        `${BASE}/jobs/${encodeURIComponent(id)}/score`,
        body,
      ),
  },

  // ── Resumes ──────────────────────────────────────────────────────
  resumes: {
    list: (params?: { kind?: RAResumeKind }) =>
      roboApi.get<ResumeListResponse>(`${BASE}/resumes${qs(params)}`),
    create: (body: ResumeCreateBody) =>
      roboApi.post<ResumeCreateResponse>(`${BASE}/resumes`, body),
    // Multipart upload — bypass `roboApi` (which doesn't thread the multipart
    // flag) and call `request` directly with a FormData body, mirroring
    // lib/api/missions.ts createMission().
    upload: async (file: File, opts?: { name?: string }) => {
      const fd = new FormData();
      // Idempotency key first, so it is parsed off the wire before the file
      // body. Derived from the bytes, so a retry of the same file — same modal
      // session or a fresh one — replays the original upload instead of
      // creating a second résumé.
      const key = await fileIdempotencyKey(file);
      if (key) fd.append('idempotencyKey', key);
      fd.append('file', file);
      if (opts?.name) fd.append('name', opts.name);
      return request<ResumeCreateResponse>('POST', `${BASE}/resumes/upload`, {
        body: fd,
        multipart: true,
      });
    },
    // LinkedIn import — config probe + create. Multipart (PDF mode carries a
    // file; URL mode sends fields only), so bypass `roboApi` like upload().
    linkedinConfig: () =>
      roboApi.get<LinkedInImportConfigResponse>(
        `${BASE}/resumes/import-linkedin/config`,
      ),
    importLinkedIn: (args: LinkedInImportArgs) => {
      const fd = new FormData();
      fd.append('mode', args.mode);
      if (args.file) fd.append('file', args.file);
      if (args.linkedinUrl) fd.append('linkedinUrl', args.linkedinUrl);
      if (args.name) fd.append('name', args.name);
      return request<ResumeCreateResponse>('POST', `${BASE}/resumes/import-linkedin`, {
        body: fd,
        multipart: true,
      });
    },
    setPrimary: (id: string) =>
      roboApi.post<ResumeCreateResponse>(
        `${BASE}/resumes/${encodeURIComponent(id)}/primary`,
        {},
      ),
    get: (id: string) =>
      roboApi.get<ResumeGetResponse>(`${BASE}/resumes/${encodeURIComponent(id)}`),
    patch: (id: string, body: ResumePatchBody) =>
      roboApi.patch<ResumePatchResponse>(
        `${BASE}/resumes/${encodeURIComponent(id)}`,
        body,
      ),
    delete: async (id: string) => {
      await roboApi.delete<void>(`${BASE}/resumes/${encodeURIComponent(id)}`);
    },
    // ── V3 inline AI — real (BE-R) ──
    rewrite: (id: string, body: ResumeRewriteBody) =>
      roboApi.post<ResumeRewriteResponse>(
        `${BASE}/resumes/${encodeURIComponent(id)}/rewrite`,
        body,
      ),
    tailorDiff: (id: string, body: ResumeTailorDiffBody) =>
      roboApi.post<ResumeTailorDiffResponse>(
        `${BASE}/resumes/${encodeURIComponent(id)}/tailor-diff`,
        body,
      ),
    tailorApply: (id: string, body: ResumeTailorApplyBody) =>
      roboApi.post<ResumeTailorApplyResponse>(
        `${BASE}/resumes/${encodeURIComponent(id)}/tailor-apply`,
        body,
      ),
    coachTips: (id: string) =>
      roboApi.get<ResumeCoachTipsResponse>(
        `${BASE}/resumes/${encodeURIComponent(id)}/coach-tips`,
      ),
  },

  // ── Insights ─────────────────────────────────────────────────────
  insights: {
    weekly: (params?: InsightsWeeklyParams) =>
      roboApi.get<InsightsWeeklyResponse>(`${BASE}/insights/weekly${qs(params)}`),
    refresh: () =>
      roboApi.post<InsightsRefreshResponse>(`${BASE}/insights/refresh`, {}),
  },

  // ── Queue — real (BE-Q, shapes the V1 auto-apply engine) ──
  queue: {
    list: () => roboApi.get<QueueListResponse>(`${BASE}/queue`),
    send: (id: string) =>
      roboApi.post<QueueItemResponse>(
        `${BASE}/queue/${encodeURIComponent(id)}/send`,
        {},
      ),
    skip: (id: string) =>
      roboApi.post<QueueItemResponse>(
        `${BASE}/queue/${encodeURIComponent(id)}/skip`,
        {},
      ),
    updateCover: (id: string, body: QueueUpdateCoverBody) =>
      roboApi.patch<QueueItemResponse>(
        `${BASE}/queue/${encodeURIComponent(id)}/cover`,
        body,
      ),
  },

  // ── Activity — real (BE-Q) ──
  activity: {
    feed: (params?: ActivityFeedParams) =>
      roboApi.get<ActivityFeedResponse>(`${BASE}/activity${qs(params)}`),
    orbStats: () =>
      roboApi.get<AgentStatsResponse>(`${BASE}/activity/orb-stats`),
  },

  // ── Mock interview — real (BE-MOCK) ──
  mock: {
    catalog: () => roboApi.get<MockCatalogResponse>(`${BASE}/mock/catalog`),
    recentSessions: () =>
      roboApi.get<MockRecentSessionsResponse>(`${BASE}/mock/recent-sessions`),
    start: (body: MockStartBody) =>
      roboApi.post<MockStartResponse>(`${BASE}/mock/start`, body),
    nextTurn: (body: MockNextTurnBody) =>
      roboApi.post<MockNextTurnResponse>(`${BASE}/mock/next-turn`, body),
    score: (sessionId: string) =>
      roboApi.post<MockScoreResponse>(
        `${BASE}/mock/${encodeURIComponent(sessionId)}/score`,
        {},
      ),
  },

  // ── Integrations — real (BE-INT) ──
  integrations: {
    list: () => roboApi.get<IntegrationsListResponse>(`${BASE}/integrations`),
    connect: (provider: RAIntegrationProvider) =>
      roboApi.post<IntegrationResponse>(
        `${BASE}/integrations/${encodeURIComponent(provider)}/connect`,
        {},
      ),
    disconnect: (provider: RAIntegrationProvider) =>
      roboApi.post<IntegrationResponse>(
        `${BASE}/integrations/${encodeURIComponent(provider)}/disconnect`,
        {},
      ),
  },

  // ── Preferences — real (BE-P) ──
  preferences: {
    get: () => roboApi.get<PreferencesGetResponse>(`${BASE}/preferences`),
    update: (body: PreferencesUpdateBody) =>
      roboApi.patch<PreferencesUpdateResponse>(`${BASE}/preferences`, body),
  },

  // ── First-run setup — plain JSON, all of it. The NDJSON chat stream that
  //    used to need a raw-fetch bypass here is deleted along with the chat. ──
  onboarding: {
    bootstrap: (body: OnboardingBootstrapBody) =>
      roboApi.post<OnboardingBootstrapResponse>(
        `${BASE}/onboarding/bootstrap`,
        body,
      ),
    getSession: () =>
      roboApi.get<OnboardingSessionResponse>(`${BASE}/onboarding/session`),
    confirm: (body: OnboardingConfirmBody) =>
      roboApi.post<OnboardingConfirmResponse>(`${BASE}/onboarding/confirm`, body),
    skip: (body?: OnboardingSkipBody) =>
      roboApi.post<OnboardingSkipResponse>(
        `${BASE}/onboarding/skip`,
        body ?? {},
      ),
    seen: (body: OnboardingSeenBody) =>
      roboApi.post<OnboardingSeenResponse>(`${BASE}/onboarding/seen`, body),
  },
  discover: {
    run: (body?: DiscoverRunBody) =>
      roboApi.post<CrossBankDiscoverResponse>(`${BASE}/discover/run`, body ?? {}),
  },
};
