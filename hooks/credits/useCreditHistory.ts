'use client';

// hooks/credits/useCreditHistory.ts — committed credit use, newest first
// (`GET /credits/history`, WP-21a). Shown under /settings#credits.

import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { getCreditHistory } from '../../lib/api/credits';
import type { Items } from '../../lib/api/contracts/wire';
import type { CreditLedgerView } from '../../lib/api/contracts/credits';
import { shouldRetryCredits } from '../shared/useCredits';

export const CREDIT_HISTORY_QUERY_KEY = ['credits', 'history'] as const;

export function useCreditHistory(limit = 20): UseQueryResult<Items<CreditLedgerView>> {
  return useQuery<Items<CreditLedgerView>>({
    queryKey: [...CREDIT_HISTORY_QUERY_KEY, limit],
    queryFn: ({ signal }) => getCreditHistory({ limit }, { signal }),
    staleTime: 30 * 1000,
    retry: shouldRetryCredits,
  });
}
