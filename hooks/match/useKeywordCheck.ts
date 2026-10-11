'use client';

// hooks/match/useKeywordCheck.ts — requirement rows for a job against a resume
// (`GET /match/jobs/:id/keyword-check`; free, deterministic; F-RES-08).
//
// Each skill and keyword of the answer carries one of three states (`shown`,
// `related`, `not_shown`), the canonical skill id, what counted for a related
// one (`via`) and, for a shown one found in the text, the resume sentence
// (`quote`). The answer also says which vocabulary read it (`vocabularyAsOf`).
// The types are the server contract's (lib/api/contracts/match).

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
