'use client';

// hooks/usePreferences.ts
//
// TanStack Query bindings for the V3 extended-preferences surface (Routes 10,
// 11). All calls route through `raV2Api.preferences.*`. Query keys namespaced
// `['v3', 'preferences', …]`.
//
// The Preferences page COMPOSES this with `goal.*` (title/salary/work-type/
// seniority/locations), the auth profile (name/email/tier), and
// `integrations.*`. This hook only owns the fields `RAPreferences` carries.
//
// WP-20: the job-targeting keys of RAPreferences (roleTitles, workModes,
// cities, salaryMinK, …) are projected by the server from the user's active
// search profile and written through to it, so a successful update also
// invalidates the search-profile queries (hooks/search). New filter UI writes
// /search-profiles directly (hooks/search/useApplyFilters).
//
// Surface:
//   - usePreferences()           GET  preferences.get (blob + static options)
//   - useUpdatePreferences()     PATCH preferences.update (partial, deep-merged)
//   - rebasePreferencesDraft()   pure: fold a refetched blob into an edited draft
//   - settlePreferencesSave()    pure: fold a save's answer into the draft
//   - changedPreferenceKeys()    pure: the top-level keys a draft changed

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';

import { raV2Api } from '../lib/api/v2';
import { LEGACY_PREFERENCES_KEY, SEARCH_BACKED_PREFERENCE_KEYS, searchKeys, withoutUnchangedSearchKeys } from './search/keys';
import type {
  PreferencesGetResponse,
  PreferencesUpdateBody,
  PreferencesUpdateResponse,
} from '../lib/api/v2';

export const preferenceKeys = {
  all: LEGACY_PREFERENCES_KEY,
  get: () => ['v3', 'preferences', 'get'] as const,
};

export function usePreferences(): UseQueryResult<
  PreferencesGetResponse,
  Error
> {
  return useQuery({
    queryKey: preferenceKeys.get(),
    queryFn: () => raV2Api.preferences.get(),
  });
}

/** Partial update — only changed fields are sent (mirror the SaveBar). On
 *  success we seed the cache with the merged result so the form reflects the
 *  server's canonical state immediately. */
export function useUpdatePreferences(): UseMutationResult<
  PreferencesUpdateResponse,
  Error,
  PreferencesUpdateBody
> {
  const qc = useQueryClient();
  return useMutation({
    // Settings sends its whole draft: unchanged search-backed keys are dropped
    // so a stale draft can never undo a filter changed in the drawer.
    mutationFn: (body: PreferencesUpdateBody) =>
      raV2Api.preferences.update(
        withoutUnchangedSearchKeys(
          body as Record<string, unknown>,
          qc.getQueryData<PreferencesGetResponse>(preferenceKeys.get())?.preferences as Record<string, unknown> | undefined,
        ) as PreferencesUpdateBody,
      ),
    onSuccess: (res) => {
      // Seed the merged blob into the existing cache entry (keeps `options`);
      // if there's no cache yet, the invalidate below refetches it.
      qc.setQueryData<PreferencesGetResponse>(preferenceKeys.get(), (prev) =>
        prev ? { ...prev, preferences: res.preferences } : prev,
      );
      void qc.invalidateQueries({ queryKey: preferenceKeys.all });
      // A job-targeting change landed on the active search profile.
      void qc.invalidateQueries({ queryKey: searchKeys.profiles() });
    },
  });
}

// ── The Settings draft (pure) ───────────────────────────────────────────────
//
// /settings edits a local copy (`draft`) of the preferences blob and compares
// it with the last server copy (`baseline`). The blob is refetched while the
// page is open: saving a saved search invalidates it, because the server
// projects the job-targeting keys from the active search profile. A refetch
// must never throw away what the user has typed and not saved yet.
//
// "What the user changed" is always read as `draft[key] ≠ baseline[key]`, for
// the keys the user can change. Two kinds of key are never the user's:
//   • the search-backed keys — Settings does not edit them, the saved
//     searches do, so they always follow the server;
//   • `updatedAt` — the server's timestamp.

type Blob = Record<string, unknown>;

/** Keys of the blob that always follow the server and are never sent back. */
const SERVER_OWNED_PREFERENCE_KEYS: ReadonlySet<string> = new Set<string>([...SEARCH_BACKED_PREFERENCE_KEYS, 'updatedAt']);

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const copy = <T,>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

export interface PreferencesDraftState<T> {
  draft: T;
  baseline: T;
}

/**
 * The PATCH body for a draft: only the top-level keys that differ from the
 * baseline, never a server-owned key. Empty when nothing changed — which is
 * also what "not dirty" means.
 */
export function changedPreferenceKeys<T extends object>(draft: T, baseline: T): Partial<T> {
  const out: Blob = {};
  for (const [key, value] of Object.entries(draft as Blob)) {
    if (SERVER_OWNED_PREFERENCE_KEYS.has(key)) continue;
    if (!same(value, (baseline as Blob)[key])) out[key] = value;
  }
  return out as Partial<T>;
}

/**
 * Fold a fresh server blob into the page's draft.
 *
 *   • No draft yet → the draft and the baseline both become the server blob.
 *   • Otherwise the baseline becomes the server blob and the draft is rebuilt
 *     key by key: a key the user changed keeps the user's value; every other
 *     key (the server-owned ones always) takes the server's. With nothing
 *     edited that is simply the server blob.
 */
export function rebasePreferencesDraft<T extends object>(
  state: PreferencesDraftState<T> | null,
  server: T,
): PreferencesDraftState<T> {
  if (!state) return { draft: copy(server), baseline: copy(server) };
  const edited = state.draft as Blob;
  const before = state.baseline as Blob;
  const fresh = server as Blob;
  const next: Blob = {};
  for (const key of new Set([...Object.keys(fresh), ...Object.keys(edited)])) {
    const userChanged = !SERVER_OWNED_PREFERENCE_KEYS.has(key) && !same(edited[key], before[key]);
    next[key] = copy(userChanged || !(key in fresh) ? edited[key] : fresh[key]);
  }
  return { draft: next as T, baseline: copy(server) };
}

/**
 * A save came back. The keys that were sent are saved now, so they stop
 * counting as changes (unless the user typed something else since), and the
 * server's answer becomes the baseline. Anything edited while the request was
 * in flight stays unsaved.
 *
 * `sent` is the PATCH body, not the whole draft the page held when Save was
 * clicked: that draft can be older than the current one (a refetch may have
 * landed in between), and comparing against it would mistake the server's own
 * newer values for edits.
 */
export function settlePreferencesSave<T extends object>(
  state: PreferencesDraftState<T> | null,
  sent: Partial<T>,
  answer: T,
): PreferencesDraftState<T> {
  if (!state) return rebasePreferencesDraft<T>(null, answer);
  const baseline = { ...(state.baseline as Blob), ...copy(sent as Blob) } as T;
  return rebasePreferencesDraft({ draft: state.draft, baseline }, answer);
}
