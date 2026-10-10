'use client';

// useResumes — TanStack Query bindings for the V2 Resume Builder pages.
//
// Surface (kept small — F3 owns three pages):
//   - useResumeList()              GET /resumes (sorted by lastEditedAt desc)
//   - useResume(id)                GET /resumes/:id
//   - useCreateResumeMutation()    POST /resumes
//   - useDeleteResumeMutation()    DELETE /resumes/:id
//
// The legacy CRUD keeps going through `raV2Api` (frozen client, TASK_PLAN.md
// §2.1 rule 9): it auto-routes to the in-memory stub in tests and stub demos,
// and WP-36b's server changes to those endpoints are additive. New calls
// (layout, export, target title) go through lib/api/resumes.ts. Query keys
// live here too so cache invalidations have one place to land.
//
// WP-36b additions: usePatchResumeLayoutMutation, useResumeExportMutation,
// and the hub fields (targetTitle, layout, unverifiedClaims, aiAssisted,
// defaultPage) on the types (absent from stub rows; every reader defaults).

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';

import { raV2Api } from '../lib/api/v2';
import {
  downloadResumeExport,
  patchResume,
  patchResumeLayout,
  uploadResume,
  type ResumeExportOptions,
  type ResumeExportResult,
  type ResumeHubPatch,
  type ResumeLayout,
  type ResumeListResult,
  type ResumeSummary,
  type ResumeVariant,
} from '../lib/api/resumes';
import type {
  RAResumeKind,
  LinkedInImportArgs,
  LinkedInImportConfigResponse,
  ResumeCoachTipsResponse,
  ResumeCreateBody,
  ResumeRewriteBody,
  ResumeRewriteResponse,
} from '../lib/api/v2/types';

/** The hub's variant (legacy shape + WP-36b fields). */
type RAResumeVariant = ResumeVariant;
/** The hub's list row (legacy shape + WP-36b fields). */
type RAResumeVariantSummary = ResumeSummary;
type ResumeListResponse = ResumeListResult;

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
 *  rewrite surface is a mutation (an LLM call on demand); only coach tips is a
 *  cacheable read. */
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
      return (await raV2Api.resumes.list(params)) as ResumeListResponse;
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
      return r.resume as RAResumeVariant;
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
      return r.resume as RAResumeVariant;
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
): UseMutationResult<RAResumeVariant, Error, ResumeHubPatch> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: ResumeHubPatch): Promise<RAResumeVariant> => {
      // targetTitle is a WP-36b field the frozen V2 client does not type.
      if (body.targetTitle !== undefined) return patchResume(id, body);
      // `aiAssisted` is additive on the same endpoint; the frozen client passes it through.
      const r = await raV2Api.resumes.patch(id, body as Parameters<typeof raV2Api.resumes.patch>[1]);
      return r.resume as RAResumeVariant;
    },
    onSuccess: (resume) => {
      // Merge: the PATCH echo has no request-scoped fields (defaultPage).
      qc.setQueryData(resumeKeys.detail(id), (prev: RAResumeVariant | undefined) => ({ ...prev, ...resume }));
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
 *  "Upload a résumé" flow and the first-run ResumeGate. `localParser: true`
 *  asks the server to read the file on its own servers only (it already does
 *  so for a user who has not agreed to the outside parsing service). */
export function useUploadResumeMutation(): UseMutationResult<
  RAResumeVariant,
  Error,
  { file: File; name?: string; localParser?: boolean }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ file, name, localParser }): Promise<RAResumeVariant> => {
      if (localParser) return uploadResume(file, { name, localParser: true });
      const r = await raV2Api.resumes.upload(file, name ? { name } : undefined);
      return r.resume as RAResumeVariant;
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
    // URL import is gone (TASK_PLAN.md H9); kept so older callers compile.
    queryFn: async () => ({ urlImportEnabled: false }),
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
      if (args.mode !== 'pdf' || !args.file) throw new Error('A LinkedIn PDF export is required.');
      const r = await raV2Api.resumes.importLinkedIn({ mode: 'pdf', file: args.file, name: args.name });
      return r.resume as RAResumeVariant;
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
      return r.resume as RAResumeVariant;
    },
    onSuccess: (resume) => {
      qc.setQueryData(resumeKeys.detail(resume.id), resume);
      qc.invalidateQueries({ queryKey: resumeKeys.all });
    },
  });
}

// ─────────────────────────────────────────────────────────────────────
// V3 inline AI — rewrite / coach tips (Route 4). Tailoring is hooks/tailor
// (tailor sessions); the legacy tailor-diff / tailor-apply hooks are gone.
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
// Hub (WP-36b): layout and export
// ─────────────────────────────────────────────────────────────────────

/** Save template / page / spacing / accent / date format. Writes the returned
 *  variant into the detail cache so the preview and the export agree. */
export function usePatchResumeLayoutMutation(
  id: string,
): UseMutationResult<RAResumeVariant, Error, Partial<ResumeLayout>> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (layout: Partial<ResumeLayout>) => patchResumeLayout(id, { layout }),
    // Optimistic: the preview follows the pick at once; a failure rolls back.
    onMutate: async (layout) => {
      await qc.cancelQueries({ queryKey: resumeKeys.detail(id) });
      const prev = qc.getQueryData<RAResumeVariant>(resumeKeys.detail(id));
      if (prev) qc.setQueryData(resumeKeys.detail(id), { ...prev, layout: { ...(prev.layout ?? {}), ...layout } });
      return { prev };
    },
    onError: (_err, _layout, ctx) => {
      const prev = (ctx as { prev?: RAResumeVariant } | undefined)?.prev;
      if (prev) qc.setQueryData(resumeKeys.detail(id), prev);
    },
    onSuccess: (resume) => {
      qc.setQueryData(resumeKeys.detail(id), (prev: RAResumeVariant | undefined) => ({ ...prev, ...resume }));
    },
  });
}

/** Download a PDF/DOCX export. Rejects with the server code
 *  (`unverified_claims`, …) readable through `apiErrorCode(err)`. */
export function useResumeExportMutation(
  id: string,
  fallbackName: string,
): UseMutationResult<ResumeExportResult, Error, ResumeExportOptions> {
  return useMutation({
    mutationFn: (options: ResumeExportOptions) => downloadResumeExport(id, options, fallbackName),
  });
}

// ─────────────────────────────────────────────────────────────────────
// Convenience exports
// ─────────────────────────────────────────────────────────────────────

export type { RAResumeVariant, RAResumeVariantSummary, RAResumeKind, ResumeLayout };
