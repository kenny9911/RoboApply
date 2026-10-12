'use client';

// hooks/profile/useProfile.ts — TanStack Query bindings for the profile area
// (WP-19). One cached profile per session, shared by the /profile page, the
// completion card and the nav badge (useProfileBadge). Every mutation writes
// the server's answer back into the cache, so the "Missing" markers, the
// completeness figure and the badge move together.

import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';

import {
  addEducation,
  addExperience,
  applySyncFromResume,
  deleteEducation,
  deleteExperience,
  getProfile,
  getSensitiveAnswers,
  patchProfile,
  previewSyncFromResume,
  putSensitiveAnswers,
  putSkills,
  updateEducation,
  updateExperience,
} from '../../lib/api/profile';
import { apiErrorCode, type In } from '../../lib/api/contracts/wire';
import type * as P from '../../lib/api/contracts/profile';

export const PROFILE_QUERY_KEY = ['profile', 'me'] as const;
export const SENSITIVE_QUERY_KEY = ['profile', 'sensitive'] as const;
export const PROFILE_STALE_MS = 5 * 60 * 1000;

/** Errors no retry can fix (signed out, area not live yet, other brand). */
const FINAL_CODES = new Set(['unauthorized', 'auth_expired', 'AUTH_REQUIRED', 'INVALID_TOKEN', 'NO_AUTH', 'auth_other_brand', 'not_implemented', 'feature_disabled', 'not_found']);

export function shouldRetryProfile(failureCount: number, error: unknown): boolean {
  const code = apiErrorCode(error);
  if (code && FINAL_CODES.has(code)) return false;
  return failureCount < 1;
}

export function useProfile(options: { enabled?: boolean } = {}): UseQueryResult<P.ProfileView> {
  return useQuery<P.ProfileView>({
    queryKey: PROFILE_QUERY_KEY,
    queryFn: ({ signal }) => getProfile({ signal }),
    staleTime: PROFILE_STALE_MS,
    retry: shouldRetryProfile,
    enabled: options.enabled ?? true,
  });
}

/** Profile mutations. Row changes refetch the profile (rows and completeness move together). */
export function useProfileMutations() {
  const qc = useQueryClient();
  const setProfile = (view: P.ProfileView) => qc.setQueryData(PROFILE_QUERY_KEY, view);
  const refetch = () => qc.invalidateQueries({ queryKey: PROFILE_QUERY_KEY });

  const patch = useMutation({
    mutationFn: (body: In<typeof P.ProfilePatchSchema>) => patchProfile(body),
    onSuccess: setProfile,
  });
  const skills = useMutation({
    mutationFn: (body: In<typeof P.PutSkillsBodySchema>) => putSkills(body),
    onSuccess: setProfile,
  });
  const saveEducation = useMutation({
    mutationFn: ({ id, body }: { id: string | null; body: In<typeof P.EducationBodySchema> }) =>
      id ? updateEducation(id, body) : addEducation(body),
    onSuccess: refetch,
  });
  const removeEducation = useMutation({ mutationFn: (id: string) => deleteEducation(id), onSuccess: refetch });
  const saveExperience = useMutation({
    mutationFn: ({ id, body }: { id: string | null; body: In<typeof P.ExperienceBodySchema> }) =>
      id ? updateExperience(id, body) : addExperience(body),
    onSuccess: refetch,
  });
  const removeExperience = useMutation({ mutationFn: (id: string) => deleteExperience(id), onSuccess: refetch });

  return { patch, skills, saveEducation, removeEducation, saveExperience, removeExperience };
}

export function useSensitiveAnswers(options: { enabled?: boolean } = {}): UseQueryResult<P.SensitiveAnswersView> {
  return useQuery<P.SensitiveAnswersView>({
    queryKey: SENSITIVE_QUERY_KEY,
    queryFn: ({ signal }) => getSensitiveAnswers({ signal }),
    // Owner-only data: never kept around after the page is left.
    gcTime: 0,
    retry: shouldRetryProfile,
    enabled: options.enabled ?? true,
  });
}

export function usePutSensitiveAnswers() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: In<typeof P.SensitiveAnswersSchema>) => putSensitiveAnswers(body),
    onSuccess: (view) => qc.setQueryData(SENSITIVE_QUERY_KEY, view),
  });
}

/** Resume → profile: preview (changes nothing), then apply the accepted paths. */
export function useResumeSync() {
  const qc = useQueryClient();
  const preview = useMutation({ mutationFn: (variantId: string) => previewSyncFromResume({ variantId }) });
  const apply = useMutation({
    mutationFn: (body: { variantId: string; accept: string[] }) => applySyncFromResume(body),
    onSuccess: (view) => qc.setQueryData(PROFILE_QUERY_KEY, view),
  });
  return { preview, apply };
}
