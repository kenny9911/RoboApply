// lib/api/alice.ts — Alice, the application agent (docs/alice/ALICE.md).
//
// Thin typed wrappers over the area contract (server/src/features/alice/
// contract.ts). Components never build these URLs; they use hooks/alice.
//
// Endpoints:
//   GET    /api/v1/roboapply/alice/thread
//   POST   /api/v1/roboapply/alice/turn                    (SSE stream)
//   GET    /api/v1/roboapply/alice/profiles
//   PATCH  /api/v1/roboapply/alice/profiles/:id
//   DELETE /api/v1/roboapply/alice/profiles/:id
//   GET    /api/v1/roboapply/alice/profiles/:id/matches
//   GET    /api/v1/roboapply/alice/applications
//   PUT    /api/v1/roboapply/alice/reminders/:entryId
//   DELETE /api/v1/roboapply/alice/reminders/:entryId
//
// D1: nothing here submits an application.

import { call, postStream, seg, withQuery, type CallOptions, type In, type SseEvent } from './contracts/wire';
import type * as AL from './contracts/alice';

/** `alice.getThread` — GET /api/v1/roboapply/alice/thread */
export function getAliceThread(opts?: CallOptions): Promise<AL.AliceThreadView> {
  return call<AL.AliceThreadView>('GET', `/api/v1/roboapply/alice/thread`, opts);
}

export interface AliceTurnOptions extends CallOptions {
  onEvent: (event: AL.AliceStreamEvent) => void;
}

/** How a turn ended: `done`, an `error` event after the stream opened, or a stream cut short. */
export type AliceTurnOutcome = { status: 'done' } | { status: 'error'; code: string; reason?: string; message: string } | { status: 'interrupted' };

const STREAM_EVENTS = new Set(['progress', 'message', 'thread', 'error', 'done']);

/**
 * `alice.turn` — POST /api/v1/roboapply/alice/turn
 *
 * One action, answered as a stream. Every event goes to `onEvent` in order.
 * Rejects with `RoboApiError` when the server refused before streaming
 * (consent, limits, a running turn, a wrong stage).
 */
export async function aliceTurn(body: In<typeof AL.AliceTurnBodySchema>, { onEvent, ...opts }: AliceTurnOptions): Promise<AliceTurnOutcome> {
  const end: { outcome: AliceTurnOutcome | null } = { outcome: null };
  const handle = (raw: SseEvent) => {
    if (end.outcome || !STREAM_EVENTS.has(raw.event) || !raw.data || typeof raw.data !== 'object') return;
    const event = { event: raw.event, data: raw.data } as AL.AliceStreamEvent;
    onEvent(event);
    if (event.event === 'done') end.outcome = { status: 'done' };
    else if (event.event === 'error') end.outcome = { status: 'error', code: event.data.code, ...(event.data.reason ? { reason: event.data.reason } : {}), message: event.data.message };
  };
  try {
    await postStream<SseEvent>(`/api/v1/roboapply/alice/turn`, body, { ...opts, onEvent: handle });
  } catch (err) {
    if (end.outcome) return end.outcome;
    if (err && typeof err === 'object' && (err as { name?: unknown }).name === 'RoboApiError') throw err;
    return { status: 'interrupted' };
  }
  return end.outcome ?? { status: 'interrupted' };
}

/** `alice.listProfiles` — GET /api/v1/roboapply/alice/profiles */
export function listAliceProfiles(opts?: CallOptions): Promise<AL.AliceProfilesResponse> {
  return call<AL.AliceProfilesResponse>('GET', `/api/v1/roboapply/alice/profiles`, opts);
}

/** `alice.patchProfile` — PATCH /api/v1/roboapply/alice/profiles/:id */
export function patchAliceProfile(id: string, body: In<typeof AL.AlicePatchProfileBodySchema>, opts?: CallOptions): Promise<AL.AliceSavedProfileView> {
  return call<AL.AliceSavedProfileView>('PATCH', `/api/v1/roboapply/alice/profiles/${seg(id)}`, { ...opts, body });
}

/** `alice.deleteProfile` — DELETE /api/v1/roboapply/alice/profiles/:id */
export function deleteAliceProfile(id: string, opts?: CallOptions): Promise<void> {
  return call<void>('DELETE', `/api/v1/roboapply/alice/profiles/${seg(id)}`, opts);
}

/** `alice.matches` — GET /api/v1/roboapply/alice/profiles/:id/matches */
export function getAliceMatches(id: string, query?: { limit?: number }, opts?: CallOptions): Promise<AL.AliceMatchesResponse> {
  return call<AL.AliceMatchesResponse>('GET', withQuery(`/api/v1/roboapply/alice/profiles/${seg(id)}/matches`, query), opts);
}

/** `alice.applications` — GET /api/v1/roboapply/alice/applications */
export function getAliceApplications(opts?: CallOptions): Promise<AL.AliceApplicationsView> {
  return call<AL.AliceApplicationsView>('GET', `/api/v1/roboapply/alice/applications`, opts);
}

/** `alice.setReminder` — PUT /api/v1/roboapply/alice/reminders/:entryId */
export function setAliceReminder(entryId: string, body: In<typeof AL.AliceReminderBodySchema>, opts?: CallOptions): Promise<AL.AliceReminderView | null> {
  return call<AL.AliceReminderView | null>('PUT', `/api/v1/roboapply/alice/reminders/${seg(entryId)}`, { ...opts, body });
}

/** `alice.clearReminder` — DELETE /api/v1/roboapply/alice/reminders/:entryId */
export function clearAliceReminder(entryId: string, opts?: CallOptions): Promise<void> {
  return call<void>('DELETE', `/api/v1/roboapply/alice/reminders/${seg(entryId)}`, opts);
}
