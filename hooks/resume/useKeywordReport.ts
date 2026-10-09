'use client';

// hooks/resume/useKeywordReport.ts — the keyword check for one resume and one
// job (WP-22; F-RES-08). Deterministic and free on the server, so it is a
// cached query. Job detail (WP-34) and tailoring (WP-36a) render it through
// components/features/resume `KeywordReport`.

import { useQuery } from '@tanstack/react-query';

import { getKeywordReport } from '../../lib/api/resumes';
import type { KeywordReportResponse } from '../../lib/api/contracts/resume';

export const keywordReportKeys = {
  forJob: (resumeId: string, jobId: string) => ['resume-check', 'keywords', resumeId, jobId] as const,
};

export function useKeywordReport(resumeId: string | null | undefined, jobId: string | null | undefined) {
  return useQuery<KeywordReportResponse>({
    queryKey: resumeId && jobId ? keywordReportKeys.forJob(resumeId, jobId) : ['resume-check', 'keywords', 'none'],
    queryFn: ({ signal }) => getKeywordReport(resumeId as string, { jobId: jobId as string }, { signal }),
    enabled: Boolean(resumeId && jobId),
    staleTime: 5 * 60_000,
  });
}
