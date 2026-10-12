'use client';

// hooks/match/useCompetitiveness.ts — "You and what employers ask"
// (`GET /match/competitiveness/latest`, `POST /match/competitiveness`;
// credit `competitiveness`; flag `competitiveness`; WP-77).
//
// The latest report per saved search is a query; creating one runs through
// the shared credit gate (one idempotency key per run, the out-of-credits
// sheet on 402, the credit summary refetched afterwards). The server reuses
// an identical report from the same day free (`reused: true`, `charged: false`).

import { useCallback, useState } from 'react';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';

import { createCompetitivenessReport, getLatestCompetitivenessReport } from '../../lib/api/match';
import { apiErrorCode } from '../../lib/api/contracts/wire';
import type { CompetitivenessReport } from '../../lib/api/contracts/match';
import { useCreditGate, type CreditGate } from '../shared/useCreditGate';
import { shouldRetryMatch } from './useJobFit';

export const competitivenessKey = (searchProfileId: string | null | undefined) => ['match', 'competitiveness', searchProfileId ?? 'none'] as const;

export function useLatestCompetitiveness(
  searchProfileId: string | null | undefined,
  options: { enabled?: boolean } = {},
): UseQueryResult<CompetitivenessReport | null> {
  return useQuery<CompetitivenessReport | null>({
    queryKey: competitivenessKey(searchProfileId),
    queryFn: ({ signal }) => getLatestCompetitivenessReport({ searchProfileId: searchProfileId! }, { signal }),
    enabled: !!searchProfileId && (options.enabled ?? true),
    staleTime: 60 * 1000,
    retry: shouldRetryMatch,
  });
}

export type CompetitivenessRunStatus = 'idle' | 'running' | 'done' | 'out_of_credits' | 'not_found' | 'error';

export interface UseCreateCompetitiveness {
  status: CompetitivenessRunStatus;
  gate: CreditGate;
  run: (searchProfileId: string) => Promise<CompetitivenessReport | null>;
}

export function useCreateCompetitiveness(): UseCreateCompetitiveness {
  const gate = useCreditGate('competitiveness');
  const client = useQueryClient();
  const [status, setStatus] = useState<CompetitivenessRunStatus>('idle');

  const run = useCallback(
    async (searchProfileId: string) => {
      setStatus('running');
      try {
        const result = await gate.run((idempotencyKey) => createCompetitivenessReport({ searchProfileId }, { idempotencyKey }));
        if (!result.ok) {
          setStatus('out_of_credits');
          return null;
        }
        client.setQueryData(competitivenessKey(searchProfileId), result.value);
        setStatus('done');
        return result.value;
      } catch (err) {
        setStatus(apiErrorCode(err) === 'not_found' ? 'not_found' : 'error');
        return null;
      }
    },
    [client, gate],
  );

  return { status, gate, run };
}
