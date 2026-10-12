'use client';

// hooks/growth/useChecklist.ts — the getting-started checklist (F-GROW-05).
//
// Read-only progress plus "close the card". Steps are completed on the
// server by the actions themselves (save a job, finalize a tailored resume,
// finish a practice interview → growth.markChecklistStep), never from here.
// Any of those actions should call `refreshChecklist(queryClient)` so the
// card updates without a reload.

import { useMutation, useQuery, useQueryClient, type QueryClient, type UseQueryResult } from '@tanstack/react-query';

import { dismissChecklist, getChecklist } from '../../lib/api/growth';
import { apiErrorCode } from '../../lib/api/contracts/wire';
import type { ChecklistView } from '../../lib/api/contracts/growth';

export const CHECKLIST_QUERY_KEY = ['growth', 'checklist'] as const;
export const CHECKLIST_STALE_MS = 60 * 1000;

/** Errors no retry can fix: signed out, area not mounted or not available yet. */
const FINAL_CODES = new Set(['unauthorized', 'auth_expired', 'AUTH_REQUIRED', 'INVALID_TOKEN', 'NO_AUTH', 'auth_other_brand', 'not_implemented', 'feature_disabled', 'not_found']);

export function shouldRetryChecklist(failureCount: number, error: unknown): boolean {
  const code = apiErrorCode(error);
  if (code && FINAL_CODES.has(code)) return false;
  return failureCount < 1;
}

export function useChecklist(options: { enabled?: boolean } = {}): UseQueryResult<ChecklistView> {
  return useQuery<ChecklistView>({
    queryKey: CHECKLIST_QUERY_KEY,
    queryFn: ({ signal }) => getChecklist({ signal }),
    staleTime: CHECKLIST_STALE_MS,
    retry: shouldRetryChecklist,
    enabled: options.enabled ?? true,
  });
}

/** Close the card for good (server-side, so it stays closed on every device). */
export function useDismissChecklist() {
  const client = useQueryClient();
  return useMutation<ChecklistView, unknown, void, { previous?: ChecklistView }>({
    mutationFn: () => dismissChecklist(),
    onMutate: async () => {
      await client.cancelQueries({ queryKey: CHECKLIST_QUERY_KEY });
      const previous = client.getQueryData<ChecklistView>(CHECKLIST_QUERY_KEY);
      if (previous) client.setQueryData<ChecklistView>(CHECKLIST_QUERY_KEY, { ...previous, dismissed: true });
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) client.setQueryData(CHECKLIST_QUERY_KEY, ctx.previous);
    },
    onSuccess: (view) => {
      client.setQueryData(CHECKLIST_QUERY_KEY, view);
    },
  });
}

/** Re-read progress after an action that may have completed a step. */
export function refreshChecklist(client: QueryClient): Promise<void> {
  return client.invalidateQueries({ queryKey: CHECKLIST_QUERY_KEY });
}
