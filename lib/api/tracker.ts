// lib/api/tracker.ts — Applications tracker additions: follow-ups, events, files sent, CSV export.
//
// Thin typed wrappers over the area contract (FND-7). Owner: WP-38.
// Request types are the contract's zod input types; response types are the
// contract's views. Change a signature here only together with its contract.
//
// Tracker list/patch stay on the legacy /v2/tracker routes (lib/api/v2,
// frozen); WP-38 extends them additively.
//
// Endpoints:
//   GET    /api/v1/roboapply/v2/tracker/follow-ups
//   GET    /api/v1/roboapply/v2/tracker/export.csv
//   GET    /api/v1/roboapply/v2/tracker/:id/events
//   POST   /api/v1/roboapply/v2/tracker/:id/events
//   GET    /api/v1/roboapply/v2/tracker/:id/artifacts

import { apiUrl, call, type CallOptions, type In, type Items, seg } from './contracts/wire';
import type * as TR from './contracts/tracker';

/** `tracker.followUps` — GET /api/v1/roboapply/v2/tracker/follow-ups */
export function listFollowUps(opts?: CallOptions): Promise<Items<TR.FollowUpView>> {
  return call<Items<TR.FollowUpView>>('GET', `/api/v1/roboapply/v2/tracker/follow-ups`, opts);
}

/** `tracker.exportCsv` — GET /api/v1/roboapply/v2/tracker/export.csv */
export function trackerExportCsvUrl(): string {
  return apiUrl(`/api/v1/roboapply/v2/tracker/export.csv`);
}

/** `tracker.events` — GET /api/v1/roboapply/v2/tracker/:id/events */
export function listTrackerEvents(id: string, opts?: CallOptions): Promise<Items<TR.TrackerEventView>> {
  return call<Items<TR.TrackerEventView>>('GET', `/api/v1/roboapply/v2/tracker/${seg(id)}/events`, opts);
}

/** `tracker.addNote` — POST /api/v1/roboapply/v2/tracker/:id/events */
export function addTrackerNote(id: string, body: In<typeof TR.AddTrackerNoteBodySchema>, opts?: CallOptions): Promise<TR.TrackerEventView> {
  return call<TR.TrackerEventView>('POST', `/api/v1/roboapply/v2/tracker/${seg(id)}/events`, { ...opts, body });
}

/** `tracker.artifacts` — GET /api/v1/roboapply/v2/tracker/:id/artifacts */
export function listTrackerArtifacts(id: string, opts?: CallOptions): Promise<Items<TR.ApplicationArtifactView>> {
  return call<Items<TR.ApplicationArtifactView>>('GET', `/api/v1/roboapply/v2/tracker/${seg(id)}/artifacts`, opts);
}

/** Every wrapper of this area, for callers that prefer one import. */
export const trackerApi = {
  listFollowUps,
  trackerExportCsvUrl,
  listTrackerEvents,
  addTrackerNote,
  listTrackerArtifacts,
};
