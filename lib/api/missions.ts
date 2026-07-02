// Typed wrappers around the mission endpoints. Backend (Wave-C) is shipped
// in parallel — some endpoints may not be live. Callers must catch
// `RoboApiError.code === 'not_found'` and degrade gracefully.

import { request, roboApi } from './client';
import type {
  RoboCreateMissionResult,
  RoboMission,
  RoboMissionPageInit,
  RoboParsedIntent,
  RoboTier,
} from './types';

// ---------------------------------------------------------------------------
// Mission CRUD
// ---------------------------------------------------------------------------

export interface CreateMissionInput {
  intentText: string;
  titles?: string[];
  tier?: RoboTier;
  timezone?: string;
  locale?: string;
  /** Resume PDF/DOCX — required for first-time onboarding. */
  resume?: File | null;
}

/**
 * Create the mission for the current user. If `resume` is supplied, posts as
 * multipart form-data; otherwise plain JSON. Backend route:
 *   POST /api/v1/roboapply/missions
 */
export function createMission(
  input: CreateMissionInput,
): Promise<RoboCreateMissionResult> {
  const useMultipart = !!input.resume;

  if (useMultipart) {
    const fd = new FormData();
    fd.append('intentText', input.intentText);
    if (input.titles && input.titles.length > 0) {
      fd.append('titles', JSON.stringify(input.titles));
    }
    if (input.tier) fd.append('tier', input.tier);
    if (input.timezone) fd.append('timezone', input.timezone);
    if (input.locale) fd.append('locale', input.locale);
    if (input.resume) fd.append('resume', input.resume);
    return request<RoboCreateMissionResult>(
      'POST',
      '/api/v1/roboapply/missions',
      { body: fd, multipart: true },
    );
  }

  return roboApi.post<RoboCreateMissionResult>('/api/v1/roboapply/missions', {
    intentText: input.intentText,
    titles: input.titles ?? [],
    tier: input.tier,
    timezone: input.timezone,
    locale: input.locale,
  });
}

/**
 * Update the intent text on the current mission. Re-fires the parser
 * backend-side, returns the updated parsedIntent.
 *
 * Backend route: PATCH /api/v1/roboapply/missions/me/intent
 */
export function updateMissionIntent(intentText: string) {
  return roboApi.patch<{ mission: RoboMission; parsedIntent: RoboParsedIntent | null }>(
    '/api/v1/roboapply/missions/me/intent',
    { intentText },
  );
}

// ---------------------------------------------------------------------------
// Mission Control page-init
// ---------------------------------------------------------------------------

/**
 * Mission Control page-init. The backend's `GET /missions/me` returns just
 * the mission row; the rest of the page-init shape (today's queued runs,
 * yesterday's submitted, last digest, week aggregate) comes from the runs
 * + digest endpoints in parallel. We assemble client-side so the page only
 * has to await one promise.
 *
 * If the user has no mission yet (404), we return null and the page renders
 * the empty-state "I'm getting set up" agent quote.
 */
export async function getMissionPage(): Promise<RoboMissionPageInit | null> {
  const { getTodayDigest } = await import('./digest');
  const { listRuns } = await import('./runs');

  try {
    // Fetch mission, today's previewing/queued/submitted runs, yesterday's
    // submitted runs, and today's digest — all in parallel. Missing pieces
    // gracefully degrade to empty arrays / null.
    // Compute "yesterday" cutoff once for the yesterday-submitted filter.
    const yest = new Date();
    yest.setDate(yest.getDate() - 1);
    const yestStart = new Date(yest.getFullYear(), yest.getMonth(), yest.getDate(), 0, 0, 0).toISOString();
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const [missionRes, todayRes, yesterdayRes, digestRes] = await Promise.allSettled([
      roboApi.get<{ mission: RoboMission }>('/api/v1/roboapply/missions/me'),
      listRuns({ status: ['previewing', 'queued', 'submitted'], limit: 30 }).catch(() => null),
      listRuns({
        status: 'submitted',
        from: yestStart,
        to: todayStart.toISOString(),
        limit: 30,
      }).catch(() => null),
      getTodayDigest().catch(() => null),
    ]);

    if (missionRes.status !== 'fulfilled') return null;
    const mission = missionRes.value.mission;
    const today = todayRes.status === 'fulfilled' ? todayRes.value : null;
    const yesterday = yesterdayRes.status === 'fulfilled' ? yesterdayRes.value : null;
    const digest = digestRes.status === 'fulfilled' ? digestRes.value : null;

    return {
      mission,
      todayQueued: today?.runs ?? [],
      yesterdaySubmitted: yesterday?.runs ?? [],
      weekSoFar: null, // weekly aggregate endpoint not yet wired — V1.1
      lastDigest: digest
        ? {
            appNarration: digest.appNarration,
            citedRunIds: digest.citedRunIds,
            sentAt: digest.sentAt,
          }
        : null,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Pause / Resume
// ---------------------------------------------------------------------------

export interface PauseInput {
  /** `24h` | `7d` | `indefinite` — server resolves the actual `pausedUntil`. */
  duration: '24h' | '7d' | 'indefinite';
}

export function pauseMission(input: PauseInput) {
  return roboApi.post<RoboMission>(
    '/api/v1/roboapply/missions/me/pause',
    input,
  );
}

export function resumeMission() {
  return roboApi.post<RoboMission>('/api/v1/roboapply/missions/me/resume');
}
