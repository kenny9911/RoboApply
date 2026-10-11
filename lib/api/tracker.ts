// lib/api/tracker.ts — Applications tracker: entries, follow-ups, events,
// files sent, CSV export and the weekly card (WP-38).
//
// Thin typed wrappers over the area contract (server/src/features/tracker/contract.ts).
// The pre-clone board read and stage move still go through the frozen
// lib/api/v2 client (`raV2Api.tracker.list/patch`, hooks/usePipelineBoard.ts);
// every new call goes through this file (TASK_PLAN.md §2.1 rule 9).
//
// Endpoints:
//   GET    /api/v1/roboapply/v2/tracker                 (view, q, source, status)
//   GET    /api/v1/roboapply/v2/tracker/:id
//   POST   /api/v1/roboapply/v2/tracker
//   PATCH  /api/v1/roboapply/v2/tracker/:id
//   DELETE /api/v1/roboapply/v2/tracker/:id
//   GET    /api/v1/roboapply/v2/tracker/follow-ups
//   GET    /api/v1/roboapply/v2/tracker/export.csv
//   GET    /api/v1/roboapply/v2/tracker/:id/events
//   POST   /api/v1/roboapply/v2/tracker/:id/events
//   GET    /api/v1/roboapply/v2/tracker/:id/artifacts
//   GET    /api/v1/roboapply/v2/insights/weekly
//   POST   /api/v1/roboapply/v2/insights/refresh

import { apiUrl, call, type CallOptions, type In, type Items, seg, withQuery } from './contracts/wire';
import type * as TR from './contracts/tracker';

const BASE = '/api/v1/roboapply/v2/tracker';
const INSIGHTS = '/api/v1/roboapply/v2/insights';

/** Legacy route (roboapply/v2/routes/tracker.ts): GET /v2/tracker with view, q, source, status. */
export function listTracker(query: In<typeof TR.TrackerListQuerySchema> = {}, opts?: CallOptions): Promise<TR.TrackerListResponse> {
  return call<TR.TrackerListResponse>('GET', withQuery(BASE, query), opts);
}

/** Legacy route: GET /v2/tracker/:id. */
export function getTrackerEntry(id: string, opts?: CallOptions): Promise<{ entry: TR.TrackerEntryView }> {
  return call<{ entry: TR.TrackerEntryView }>('GET', `${BASE}/${seg(id)}`, opts);
}

/** Legacy route: POST /v2/tracker (a job id, or a job found elsewhere). */
export function createTrackerEntry(body: In<typeof TR.TrackerCreateBodySchema>, opts?: CallOptions): Promise<{ entry: TR.TrackerEntryView }> {
  return call<{ entry: TR.TrackerEntryView }>('POST', BASE, { ...opts, body });
}

/** Legacy route: PATCH /v2/tracker/:id (every change is recorded in the timeline). */
export function patchTrackerEntry(id: string, body: In<typeof TR.TrackerPatchBodySchema>, opts?: CallOptions): Promise<{ entry: TR.TrackerEntryView }> {
  return call<{ entry: TR.TrackerEntryView }>('PATCH', `${BASE}/${seg(id)}`, { ...opts, body });
}

/** Legacy route: DELETE /v2/tracker/:id (soft delete). */
export function deleteTrackerEntry(id: string, opts?: CallOptions): Promise<void> {
  return call<void>('DELETE', `${BASE}/${seg(id)}`, opts);
}

/** `tracker.followUps` — GET /api/v1/roboapply/v2/tracker/follow-ups */
export function listFollowUps(opts?: CallOptions): Promise<TR.FollowUpsResponse> {
  return call<TR.FollowUpsResponse>('GET', `/api/v1/roboapply/v2/tracker/follow-ups`, opts);
}

/**
 * `tracker.exportCsv` — GET /api/v1/roboapply/v2/tracker/export.csv
 * `timeZone` (an IANA name, the reader's browser zone) makes the file carry the
 * dates the page shows; without it the server uses the account's stored zone.
 */
export function trackerExportCsvUrl(timeZone?: string | null): string {
  // A download link (5 a day per user; the server answers 429 past that).
  return apiUrl(withQuery(`/api/v1/roboapply/v2/tracker/export.csv`, { tz: timeZone || undefined }));
}

/** `tracker.events` — GET /api/v1/roboapply/v2/tracker/:id/events */
export function listTrackerEvents(id: string, opts?: CallOptions): Promise<Items<TR.TrackerEventView>> {
  return call<Items<TR.TrackerEventView>>('GET', `${BASE}/${seg(id)}/events`, opts);
}

/** `tracker.addNote` — POST /api/v1/roboapply/v2/tracker/:id/events */
export function addTrackerNote(id: string, body: In<typeof TR.AddTrackerNoteBodySchema>, opts?: CallOptions): Promise<TR.TrackerEventView> {
  return call<TR.TrackerEventView>('POST', `${BASE}/${seg(id)}/events`, { ...opts, body });
}

/** `tracker.artifacts` — GET /api/v1/roboapply/v2/tracker/:id/artifacts */
export function listTrackerArtifacts(id: string, opts?: CallOptions): Promise<Items<TR.ApplicationArtifactView>> {
  return call<Items<TR.ApplicationArtifactView>>('GET', `${BASE}/${seg(id)}/artifacts`, opts);
}

/** The week a weekly-insight call is about and the reader's zone (both optional; `WeeklyInsightQuerySchema`). */
export interface WeeklyInsightScope {
  /** The week the card shows (its start, YYYY-MM-DD). Default: the current week. */
  weekStartUtc?: string;
  /** The reader's IANA time zone, so the week is counted in it. Default: the account's stored zone. */
  tz?: string | null;
}

/**
 * Legacy V2 mount (roboapply/v2/routes/insights.ts): GET /v2/insights/weekly.
 * The first argument is the week's start, or a `{ weekStartUtc, tz }` scope.
 */
export function getWeeklyInsight(week?: string | WeeklyInsightScope, opts?: CallOptions): Promise<TR.WeeklyInsightResponse> {
  const scope: WeeklyInsightScope = typeof week === 'string' ? { weekStartUtc: week } : (week ?? {});
  return call<TR.WeeklyInsightResponse>('GET', withQuery(`${INSIGHTS}/weekly`, { weekStartUtc: scope.weekStartUtc, tz: scope.tz || undefined }), opts);
}

/**
 * Legacy V2 mount: POST /v2/insights/refresh (AI summary; 1 an hour). With a
 * scope the summary is written for the week the card shows, in the reader's
 * zone (`WeeklyInsightRefreshBodySchema`); without one, for the current week.
 */
export function refreshWeeklyInsight(scope?: WeeklyInsightScope, opts?: CallOptions): Promise<TR.WeeklyInsightResponse> {
  const body = scope && (scope.weekStartUtc || scope.tz) ? { ...(scope.weekStartUtc ? { weekStartUtc: scope.weekStartUtc } : {}), ...(scope.tz ? { tz: scope.tz } : {}) } : undefined;
  return call<TR.WeeklyInsightResponse>('POST', `${INSIGHTS}/refresh`, body ? { ...opts, body } : opts);
}

/** Every wrapper of this area, for callers that prefer one import. */
export const trackerApi = {
  listTracker,
  getTrackerEntry,
  createTrackerEntry,
  patchTrackerEntry,
  deleteTrackerEntry,
  listFollowUps,
  trackerExportCsvUrl,
  listTrackerEvents,
  addTrackerNote,
  listTrackerArtifacts,
  getWeeklyInsight,
  refreshWeeklyInsight,
};
