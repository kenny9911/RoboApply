'use client';

// useResumes — TanStack Query bindings for the V2 Resume Builder pages.
//
// Surface (kept small — F3 owns three pages):
//   - useResumeList()              GET /resumes (sorted by lastEditedAt desc)
//   - useResume(id)                GET /resumes/:id
//   - useCreateResumeMutation()    POST /resumes
//   - useDeleteResumeMutation()    DELETE /resumes/:id
//
// All calls go through `raV2Api` so they auto-route to the in-memory stub
// (Wave 2 default) or the real fetch backend (Wave 4+). Query keys live
// here too so future cache invalidations have one place to land.

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';

import { raV2Api } from '../lib/api/v2';
import type {
  RAResumeKind,
  RAResumeVariant,
  RAResumeVariantSummary,
  LinkedInImportArgs,
  LinkedInImportConfigResponse,
  ResumeCoachTipsResponse,
  ResumeCreateBody,
  ResumeListResponse,
  ResumePatchBody,
  ResumeRewriteBody,
  ResumeRewriteResponse,
  ResumeTailorDiffBody,
  ResumeTailorDiffResponse,
  ResumeTailorApplyBody,
  ResumeTailorApplyResponse,
} from '../lib/api/v2/types';

// ─────────────────────────────────────────────────────────────────────
// Query keys
// ─────────────────────────────────────────────────────────────────────

export const resumeKeys = {
  all: ['v2', 'resumes'] as const,
  list: (kind?: RAResumeKind) =>
    ['v2', 'resumes', 'list', kind ?? 'all'] as const,
  detail: (id: string) => ['v2', 'resumes', 'detail', id] as const,
};

/** V3 inline-AI query keys (namespaced `['v3', …]` per the build rules). The
 *  rewrite + tailor-diff surfaces are mutations (LLM calls on demand); only
 *  coach tips is a cacheable read. */
export const resumeV3Keys = {
  coachTips: (id: string) => ['v3', 'resumes', 'coachTips', id] as const,
};

// ─────────────────────────────────────────────────────────────────────
// List + detail queries
// ─────────────────────────────────────────────────────────────────────

export function useResumeList(
  params?: { kind?: RAResumeKind },
): UseQueryResult<ResumeListResponse, Error> {
  return useQuery({
    queryKey: resumeKeys.list(params?.kind),
    queryFn: async (): Promise<ResumeListResponse> => {
      return raV2Api.resumes.list(params);
    },
  });
}

export function useResume(
  id: string | null | undefined,
): UseQueryResult<RAResumeVariant, Error> {
  return useQuery({
    queryKey: id ? resumeKeys.detail(id) : ['v2', 'resumes', 'detail', 'null'],
    enabled: !!id,
    queryFn: async (): Promise<RAResumeVariant> => {
      if (!id) throw new Error('Resume id is required');
      const r = await raV2Api.resumes.get(id);
      return r.resume;
    },
  });
}

// ─────────────────────────────────────────────────────────────────────
// Mutations
// ─────────────────────────────────────────────────────────────────────

export function useCreateResumeMutation(): UseMutationResult<
  RAResumeVariant,
  Error,
  ResumeCreateBody
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: ResumeCreateBody): Promise<RAResumeVariant> => {
      const r = await raV2Api.resumes.create(body);
      return r.resume;
    },
    onSuccess: () => {
      // Invalidate every list variant (filtered or not) so the new row
      // appears at the top after navigation.
      qc.invalidateQueries({ queryKey: resumeKeys.all });
    },
  });
}

export function usePatchResumeMutation(
  id: string,
): UseMutationResult<RAResumeVariant, Error, ResumePatchBody> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: ResumePatchBody): Promise<RAResumeVariant> => {
      const r = await raV2Api.resumes.patch(id, body);
      return r.resume;
    },
    onSuccess: (resume) => {
      qc.setQueryData(resumeKeys.detail(id), resume);
      qc.invalidateQueries({ queryKey: ['v2', 'resumes', 'list'] });
    },
  });
}

export function useDeleteResumeMutation(): UseMutationResult<
  void,
  Error,
  string
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string): Promise<void> => {
      await raV2Api.resumes.delete(id);
    },
    onSuccess: (_void, id) => {
      qc.invalidateQueries({ queryKey: resumeKeys.all });
      qc.removeQueries({ queryKey: resumeKeys.detail(id) });
    },
  });
}

/** Upload + parse a résumé file → new base variant. Used by the resume library
 *  "Upload a résumé" flow and the first-run ResumeGate. */
export function useUploadResumeMutation(): UseMutationResult<
  RAResumeVariant,
  Error,
  { file: File; name?: string }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ file, name }): Promise<RAResumeVariant> => {
      const r = await raV2Api.resumes.upload(file, name ? { name } : undefined);
      return r.resume;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: resumeKeys.all });
    },
  });
}

/** Whether this deployment offers the optional "paste a LinkedIn URL" import
 *  path. PDF-export upload is always available; the URL field is gated on a
 *  configured enrichment provider. Cheap, cacheable read. */
export function useLinkedInImportConfig(): UseQueryResult<
  LinkedInImportConfigResponse,
  Error
> {
  return useQuery({
    queryKey: ['v2', 'resumes', 'linkedinConfig'] as const,
    queryFn: () => raV2Api.resumes.linkedinConfig(),
    staleTime: 5 * 60_000,
  });
}

/** Import a résumé from LinkedIn — a "Save to PDF" export (mode 'pdf') or a
 *  public profile URL (mode 'url'). Creates a base variant; the parse is FREE. */
export function useImportLinkedInMutation(): UseMutationResult<
  RAResumeVariant,
  Error,
  LinkedInImportArgs
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: LinkedInImportArgs): Promise<RAResumeVariant> => {
      const r = await raV2Api.resumes.importLinkedIn(args);
      return r.resume;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: resumeKeys.all });
    },
  });
}

/** Mark a variant as the user's primary résumé. */
export function useSetPrimaryResumeMutation(): UseMutationResult<
  RAResumeVariant,
  Error,
  string
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string): Promise<RAResumeVariant> => {
      const r = await raV2Api.resumes.setPrimary(id);
      return r.resume;
    },
    onSuccess: (resume) => {
      qc.setQueryData(resumeKeys.detail(resume.id), resume);
      qc.invalidateQueries({ queryKey: resumeKeys.all });
    },
  });
}

// ─────────────────────────────────────────────────────────────────────
// V3 inline AI — rewrite / tailor diff / coach tips (Route 4)
// ─────────────────────────────────────────────────────────────────────

/** Inline AI rewrite (bullet / summary / skills). A mutation because each call
 *  is an on-demand LLM run; the editor consumes the result imperatively. */
export function useResumeRewrite(
  id: string,
): UseMutationResult<ResumeRewriteResponse, Error, ResumeRewriteBody> {
  return useMutation({
    mutationFn: (body: ResumeRewriteBody) => raV2Api.resumes.rewrite(id, body),
  });
}

/** Propose a tailor diff for a job. Does NOT create the variant — the preview
 *  is materialized via `useResumeTailorApply` (which persists the previewed
 *  markdown directly, with no second LLM call). */
export function useResumeTailorDiff(
  id: string,
): UseMutationResult<ResumeTailorDiffResponse, Error, ResumeTailorDiffBody> {
  return useMutation({
    mutationFn: (body: ResumeTailorDiffBody) =>
      raV2Api.resumes.tailorDiff(id, body),
  });
}

/** Persist a tailor preview as a new tailored variant. Deterministic — no LLM
 *  re-run, no second charge. Invalidates the list so the new variant appears. */
export function useResumeTailorApply(
  id: string,
): UseMutationResult<ResumeTailorApplyResponse, Error, ResumeTailorApplyBody> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ResumeTailorApplyBody) => raV2Api.resumes.tailorApply(id, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: resumeKeys.all });
    },
  });
}

/** Coach tips for the editor's cycling panel. Cheap, cacheable read. */
export function useResumeCoachTips(
  id: string | null | undefined,
): UseQueryResult<ResumeCoachTipsResponse, Error> {
  return useQuery({
    queryKey: id
      ? resumeV3Keys.coachTips(id)
      : ['v3', 'resumes', 'coachTips', 'null'],
    enabled: !!id,
    queryFn: () => {
      if (!id) throw new Error('Resume id is required');
      return raV2Api.resumes.coachTips(id);
    },
  });
}

// ─────────────────────────────────────────────────────────────────────
// Convenience exports
// ─────────────────────────────────────────────────────────────────────

export type { RAResumeVariant, RAResumeVariantSummary, RAResumeKind };
