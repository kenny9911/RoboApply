'use client';

// hooks/match/useKeywordCheck.ts — requirement rows for a job against a resume
// (`GET /match/jobs/:id/keyword-check`; free, deterministic; F-RES-08).

import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { getKeywordCheck } from '../../lib/api/match';
import type { KeywordCheckResponse } from '../../lib/api/contracts/match';
import { shouldRetryMatch } from './useJobFit';

export const keywordCheckKey = (jobId: string, resumeVariantId?: string | null) => ['match', 'keywordCheck', jobId, resumeVariantId ?? 'primary'] as const;

export function useKeywordCheck(
  jobId: string | null | undefined,
  options: { resumeVariantId?: string | null; enabled?: boolean } = {},
): UseQueryResult<KeywordCheckResponse> {
  return useQuery<KeywordCheckResponse>({
    queryKey: keywordCheckKey(jobId ?? '', options.resumeVariantId),
    queryFn: ({ signal }) => getKeywordCheck(jobId!, options.resumeVariantId ? { resumeVariantId: options.resumeVariantId } : {}, { signal }),
    enabled: !!jobId && (options.enabled ?? true),
    staleTime: 60 * 1000,
    retry: shouldRetryMatch,
  });
}
