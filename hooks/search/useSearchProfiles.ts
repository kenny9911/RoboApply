'use client';

// hooks/search/useSearchProfiles.ts — saved searches (the one preference store) (WP-20).
//
//   useSearchProfiles()          GET  /search-profiles (first call migrates legacy prefs server-side)
//   useActiveSearchProfile()     the profile the feed uses now (from the same query)
//   useCreateSearchProfile()     POST
//   useUpdateSearchProfile()     PATCH with baseVersion (filters | filtersPatch | name | alerts | makeDefault)
//   useDeleteSearchProfile()     DELETE
//   useActivateSearchProfile()   POST /:id/activate
//
// Every write reseeds the list. The legacy preferences query (GET
// /v2/preferences projects the ACTIVE profile's filters) is invalidated only
// when that projection can change: a filters/filtersPatch change to the active
// profile, an activate, a create that activates, or deleting the active
// profile. A rename, an alert change or a makeDefault leaves it alone, so the
// Settings page (which reseeds its draft whenever that query refetches) never
// loses unsaved edits to an unrelated saved-search write. A 409
// version_conflict puts the server's current profile into the cache before
// the error reaches the caller, so the drawer can reload it and say so.

import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';

import {
  activateSearchProfile,
  createSearchProfile,
  deleteSearchProfile,
  listSearchProfiles,
  updateSearchProfile,
  type UpdateSearchProfileBody,
} from '../../lib/api/search';
import { apiErrorCode, apiErrorDetails } from '../../lib/api/contracts/wire';
import type * as S from '../../lib/api/contracts/search';
import { LEGACY_PREFERENCES_KEY, searchKeys } from './keys';

export type SearchProfile = S.SearchProfileWire;
export type SearchProfileList = S.SearchProfileListWire;

/** Search-area error reasons (contract SEARCH_ERROR_CODES) carried in `details.reason`. */
export type SearchErrorReason =
  | 'version_conflict'
  | 'saved_search_limit'
  | 'alert_frequency_not_allowed'
  | 'invalid_filters'
  | 'search_profile_not_found'
  | 'cannot_delete_last_profile'
  | 'cannot_delete_default_profile'
  | 'unknown';

/** What went wrong with a search write, for the UI's plain-language message. */
export function searchErrorReason(err: unknown): SearchErrorReason {
  const code = apiErrorCode(err);
  if (code === 'version_conflict') return 'version_conflict';
  const reason = apiErrorDetails<{ reason?: string }>(err)?.reason;
  switch (reason) {
    case 'saved_search_limit':
    case 'alert_frequency_not_allowed':
    case 'invalid_filters':
    case 'search_profile_not_found':
    case 'cannot_delete_last_profile':
    case 'cannot_delete_default_profile':
      return reason;
    default:
      return 'unknown';
  }
}

/** The server's current profile from a 409 version_conflict, if any. */
export function conflictProfile(err: unknown): SearchProfile | null {
  if (apiErrorCode(err) !== 'version_conflict') return null;
  return apiErrorDetails<{ profile?: SearchProfile }>(err)?.profile ?? null;
}

export function useSearchProfiles(options: { enabled?: boolean } = {}) {
  return useQuery<SearchProfileList>({
    queryKey: searchKeys.profiles(),
    queryFn: () => listSearchProfiles(),
    enabled: options.enabled ?? true,
    staleTime: 30_000,
  });
}

/** The active profile (the one the feed uses), else the default; null while loading. */
export function pickActiveProfile(list: SearchProfileList | undefined): SearchProfile | null {
  if (!list?.profiles.length) return null;
  return list.profiles.find((p) => p.isActive) ?? list.profiles.find((p) => p.isDefault) ?? list.profiles[0];
}

export function useActiveSearchProfile() {
  const query = useSearchProfiles();
  return { ...query, profile: pickActiveProfile(query.data) };
}

function upsertProfile(qc: QueryClient, profile: SearchProfile, opts: { exclusive?: 'isActive' | 'isDefault' } = {}) {
  qc.setQueryData<SearchProfileList>(searchKeys.profiles(), (prev) => {
    if (!prev) return prev;
    const has = prev.profiles.some((p) => p.id === profile.id);
    let profiles = has ? prev.profiles.map((p) => (p.id === profile.id ? profile : p)) : [...prev.profiles, profile];
    const flag = opts.exclusive;
    if (flag && profile[flag]) profiles = profiles.map((p) => (p.id === profile.id ? p : { ...p, [flag]: false }));
    return { ...prev, profiles };
  });
}

/** The kinds of saved-search write, for {@link changesPreferencesProjection}. */
export type SearchProfileWrite =
  | { kind: 'create'; profile: SearchProfile }
  | { kind: 'update'; profile: SearchProfile; body: UpdateSearchProfileBody }
  | { kind: 'delete'; wasActive: boolean }
  | { kind: 'activate' };

/**
 * Whether a write can change what GET /v2/preferences returns (the active
 * profile's filters, projected). Pure, for tests.
 */
export function changesPreferencesProjection(write: SearchProfileWrite): boolean {
  switch (write.kind) {
    case 'activate':
      return true;
    case 'create':
      return write.profile.isActive;
    case 'delete':
      return write.wasActive;
    case 'update':
      return write.profile.isActive && (write.body.filters !== undefined || write.body.filtersPatch !== undefined);
  }
}

function afterWrite(qc: QueryClient, write: SearchProfileWrite) {
  void qc.invalidateQueries({ queryKey: searchKeys.profiles() });
  if (changesPreferencesProjection(write)) void qc.invalidateQueries({ queryKey: LEGACY_PREFERENCES_KEY });
}

export function useCreateSearchProfile() {
  const qc = useQueryClient();
  return useMutation<SearchProfile, Error, Parameters<typeof createSearchProfile>[0]>({
    mutationFn: (body) => createSearchProfile(body),
    onSuccess: (profile) => {
      upsertProfile(qc, profile, { exclusive: profile.isActive ? 'isActive' : profile.isDefault ? 'isDefault' : undefined });
      afterWrite(qc, { kind: 'create', profile });
    },
  });
}

export interface UpdateSearchProfileVars {
  id: string;
  body: UpdateSearchProfileBody;
}

export function useUpdateSearchProfile() {
  const qc = useQueryClient();
  return useMutation<SearchProfile, Error, UpdateSearchProfileVars>({
    mutationFn: ({ id, body }) => updateSearchProfile(id, body),
    onSuccess: (profile, vars) => {
      upsertProfile(qc, profile, { exclusive: vars.body.makeDefault ? 'isDefault' : undefined });
      afterWrite(qc, { kind: 'update', profile, body: vars.body });
    },
    onError: (err) => {
      const current = conflictProfile(err);
      if (current) upsertProfile(qc, current);
    },
  });
}

export function useDeleteSearchProfile() {
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (id) => deleteSearchProfile(id),
    onSuccess: (_void, id) => {
      const before = qc.getQueryData<SearchProfileList>(searchKeys.profiles());
      // Unknown (no cached list) counts as active: refetching is the safe side.
      const wasActive = before ? before.profiles.some((p) => p.id === id && p.isActive) : true;
      qc.setQueryData<SearchProfileList>(searchKeys.profiles(), (prev) => (prev ? { ...prev, profiles: prev.profiles.filter((p) => p.id !== id) } : prev));
      afterWrite(qc, { kind: 'delete', wasActive });
    },
  });
}

export function useActivateSearchProfile() {
  const qc = useQueryClient();
  return useMutation<SearchProfile, Error, string>({
    mutationFn: (id) => activateSearchProfile(id),
    onSuccess: (profile) => {
      upsertProfile(qc, profile, { exclusive: 'isActive' });
      afterWrite(qc, { kind: 'activate' });
      // The feed reads the active profile.
      void qc.invalidateQueries({ queryKey: ['feed'] });
    },
  });
}
