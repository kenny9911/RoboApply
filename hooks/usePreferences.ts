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

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';

import { raV2Api } from '../lib/api/v2';
import { LEGACY_PREFERENCES_KEY, searchKeys, withoutUnchangedSearchKeys } from './search/keys';
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
