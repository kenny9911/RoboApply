// lib/api/uiState.ts — per-user UI state: tours seen, dismissals, the popup
// budget, announcements seen and small per-feature values (FND-3 server,
// FND-7 client; complete, stays with FND).
//
// PATCH sends operations, never a whole document, so two tabs never
// overwrite each other; the server stamps every time. `popupShown` feeds the
// one-popup-per-view / 24 h budget in lib/ui/popupGate.ts (FND-6a).
//
// Endpoints:
//   GET    /api/v1/roboapply/ui-state
//   PATCH  /api/v1/roboapply/ui-state

import { call, type CallOptions, type In } from './contracts/wire';
import type * as U from './contracts/uistate';

export type UiStatePatch = In<typeof U.UiStatePatchSchema>;
export type { UiState, UiStateResponse, UiValue, Dismissal } from './contracts/uistate';

const PATH = '/api/v1/roboapply/ui-state';

/** GET /api/v1/roboapply/ui-state */
export function getUiState(opts?: CallOptions): Promise<U.UiStateResponse> {
  return call<U.UiStateResponse>('GET', PATH, opts);
}

/** PATCH /api/v1/roboapply/ui-state — at least one operation. */
export function patchUiState(patch: UiStatePatch, opts?: CallOptions): Promise<U.UiStateResponse> {
  return call<U.UiStateResponse>('PATCH', PATH, { ...opts, body: patch });
}

/** Mark tours seen (first-seen time is kept on repeat). */
export function markToursSeen(keys: string[], opts?: CallOptions): Promise<U.UiStateResponse> {
  return patchUiState({ toursSeen: keys }, opts);
}

/** Record a dismissal (count += 1). */
export function dismiss(keys: string[], opts?: CallOptions): Promise<U.UiStateResponse> {
  return patchUiState({ dismiss: keys }, opts);
}

/** Forget dismissals. */
export function undismiss(keys: string[], opts?: CallOptions): Promise<U.UiStateResponse> {
  return patchUiState({ undismiss: keys }, opts);
}

/** The popup gate showed a popup now (server stamps the time). */
export function recordPopupShown(opts?: CallOptions): Promise<U.UiStateResponse> {
  return patchUiState({ popupShown: true }, opts);
}

/** Set small per-feature values; `null` deletes a key. */
export function setUiValues(values: NonNullable<UiStatePatch['values']>, opts?: CallOptions): Promise<U.UiStateResponse> {
  return patchUiState({ values }, opts);
}

/** Every wrapper of this area, for callers that prefer one import. */
export const uiStateApi = {
  getUiState,
  patchUiState,
  markToursSeen,
  dismiss,
  undismiss,
  recordPopupShown,
  setUiValues,
};
