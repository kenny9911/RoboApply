'use client';

// hooks/prep/usePrep.ts — query/mutation hooks for practice questions (WP-59).
// API calls go through lib/api/prep only.

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  adminApproveContribution,
  adminCreateQuestion,
  adminListContributions,
  adminListQuestions,
  adminRejectContribution,
  adminSetQuestionHidden,
  contributeQuestion,
  generateJobQuestions,
  generateQuestionGuide,
  getJobQuestions,
  getQuestion,
  listCompanyQuestions,
  listCuratedQuestions,
  listPrepCompanies,
  reportQuestion,
} from '../../lib/api/prep';
import type {
  ApproveContributionBodySchema,
  ContributionBodySchema,
  CreateCuratedQuestionBodySchema,
  JobQuestionSetResponse,
  QuestionCategory,
  QuestionDetail,
  RejectContributionBodySchema,
  ReportQuestionBodySchema,
} from '../../lib/api/contracts/prep';
import type { In } from '../../lib/api/contracts/wire';

export type ContributionStatusFilter = 'pending' | 'approved' | 'rejected';
export type AdminQuestionFilter = 'reported' | 'hidden' | 'curated';

export const prepKeys = {
  all: ['prep'] as const,
  companies: (q: string) => ['prep', 'companies', q] as const,
  company: (slug: string, category: QuestionCategory | null) => ['prep', 'company', slug, category] as const,
  curated: (category: QuestionCategory | null) => ['prep', 'curated', category] as const,
  question: (id: string) => ['prep', 'question', id] as const,
  job: (jobId: string) => ['prep', 'job', jobId] as const,
  adminContributions: (status: ContributionStatusFilter) => ['prep', 'admin', 'contributions', status] as const,
  adminQuestions: (filter: AdminQuestionFilter) => ['prep', 'admin', 'questions', filter] as const,
};

const nextCursor = (last: { cursor: string | null }) => last.cursor ?? undefined;

export function usePrepCompanies(query: string) {
  const q = query.trim();
  return useInfiniteQuery({
    queryKey: prepKeys.companies(q),
    queryFn: ({ pageParam, signal }) => listPrepCompanies({ ...(q ? { q } : {}), ...(pageParam ? { cursor: pageParam } : {}) }, { signal }),
    initialPageParam: null as string | null,
    getNextPageParam: nextCursor,
  });
}

export function useCompanyQuestions(slug: string, category: QuestionCategory | null) {
  return useInfiniteQuery({
    queryKey: prepKeys.company(slug, category),
    queryFn: ({ pageParam, signal }) => listCompanyQuestions(slug, { ...(category ? { category } : {}), ...(pageParam ? { cursor: pageParam } : {}) }, { signal }),
    initialPageParam: null as string | null,
    getNextPageParam: nextCursor,
    enabled: slug.length > 0,
  });
}

export function useCuratedQuestions(category: QuestionCategory | null) {
  return useInfiniteQuery({
    queryKey: prepKeys.curated(category),
    queryFn: ({ pageParam, signal }) => listCuratedQuestions({ ...(category ? { category } : {}), ...(pageParam ? { cursor: pageParam } : {}) }, { signal }),
    initialPageParam: null as string | null,
    getNextPageParam: nextCursor,
  });
}

/** One question; `enabled` lets the card load it only when opened. */
export function useQuestionDetail(id: string, enabled: boolean) {
  return useQuery({ queryKey: prepKeys.question(id), queryFn: ({ signal }) => getQuestion(id, { signal }), enabled, staleTime: 5 * 60_000 });
}

export function useGenerateGuide(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => generateQuestionGuide(id),
    onSuccess: (detail: QuestionDetail) => qc.setQueryData(prepKeys.question(id), detail),
  });
}

export function useReportQuestion(id: string) {
  return useMutation({ mutationFn: (body: In<typeof ReportQuestionBodySchema>) => reportQuestion(id, body) });
}

export function useContributeQuestion() {
  return useMutation({ mutationFn: (body: In<typeof ContributionBodySchema>) => contributeQuestion(body) });
}

export function useJobQuestions(jobId: string | null) {
  return useQuery({
    queryKey: prepKeys.job(jobId ?? ''),
    queryFn: ({ signal }) => getJobQuestions(jobId as string, { signal }),
    enabled: Boolean(jobId),
    staleTime: Infinity,
  });
}

export function useGenerateJobQuestions(jobId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => generateJobQuestions(jobId),
    onSuccess: (set: JobQuestionSetResponse) => qc.setQueryData(prepKeys.job(jobId), set),
  });
}

// ── Admin ────────────────────────────────────────────────────────────────

export function useAdminContributions(status: ContributionStatusFilter, enabled = true) {
  return useInfiniteQuery({
    queryKey: prepKeys.adminContributions(status),
    queryFn: ({ pageParam, signal }) => adminListContributions({ status, ...(pageParam ? { cursor: pageParam } : {}) }, { signal }),
    initialPageParam: null as string | null,
    getNextPageParam: nextCursor,
    enabled,
  });
}

export function useAdminQuestions(filter: AdminQuestionFilter, enabled = true) {
  return useInfiniteQuery({
    queryKey: prepKeys.adminQuestions(filter),
    queryFn: ({ pageParam, signal }) => adminListQuestions({ filter, ...(pageParam ? { cursor: pageParam } : {}) }, { signal }),
    initialPageParam: null as string | null,
    getNextPageParam: nextCursor,
    enabled,
  });
}

function useAdminInvalidate() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: prepKeys.all });
}

export function useApproveContribution() {
  const invalidate = useAdminInvalidate();
  return useMutation({
    mutationFn: (v: { id: string; body: In<typeof ApproveContributionBodySchema> }) => adminApproveContribution(v.id, v.body),
    onSuccess: invalidate,
  });
}

export function useRejectContribution() {
  const invalidate = useAdminInvalidate();
  return useMutation({
    mutationFn: (v: { id: string; body: In<typeof RejectContributionBodySchema> }) => adminRejectContribution(v.id, v.body),
    onSuccess: invalidate,
  });
}

export function useSetQuestionHidden() {
  const invalidate = useAdminInvalidate();
  return useMutation({ mutationFn: (v: { id: string; hidden: boolean }) => adminSetQuestionHidden(v.id, v.hidden), onSuccess: invalidate });
}

export function useCreateCuratedQuestion() {
  const invalidate = useAdminInvalidate();
  return useMutation({ mutationFn: (body: In<typeof CreateCuratedQuestionBodySchema>) => adminCreateQuestion(body), onSuccess: invalidate });
}
