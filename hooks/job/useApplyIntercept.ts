'use client';

// hooks/job/useApplyIntercept.ts — the one-time "Tailor first?" sheet before
// "Apply on company site" (PRODUCT F-JOB-06; WP-34).
//
// Shown when the user has no resume tailored for this job, at most once per
// job, and never again after "Don't ask again". The memory lives in the
// server-side ui-state (follows the user across devices):
//   dismissals['applyIntercept:<jobId>']   shown for this job
//   values['applyIntercept.never'] = true  "Don't ask again"
// The sheet is the user's own click (not an unprompted popup), so it does not
// spend the popup gate's budget. While ui-state is unknown (loading or failed)
// we do not ask: a missed prompt is better than a repeated one.

import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { dismiss, getUiState, setUiValues } from '../../lib/api/uiState';
import { UI_STATE_QUERY_KEY } from '../../lib/ui/popupGate';
import type { UiStateResponse } from '../../lib/api/contracts/uistate';

export const APPLY_INTERCEPT_NEVER = 'applyIntercept.never';
export const applyInterceptKey = (jobId: string) => `applyIntercept:${jobId}`.slice(0, 64);

/** Pure: should the sheet show for this job? */
export function shouldAskBeforeApply(state: UiStateResponse['state'] | null | undefined, jobId: string, hasTailoredResume: boolean): boolean {
  if (hasTailoredResume || !state) return false;
  if (state.values?.[APPLY_INTERCEPT_NEVER] === true) return false;
  return !state.dismissals?.[applyInterceptKey(jobId)];
}

export interface ApplyIntercept {
  shouldAsk: boolean;
  /** Remember that the sheet was shown for this job. */
  markShown(): Promise<void>;
  /** "Don't ask again". */
  neverAsk(): Promise<void>;
}

export function useApplyIntercept(jobId: string, hasTailoredResume: boolean): ApplyIntercept {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: UI_STATE_QUERY_KEY,
    queryFn: ({ signal }) => getUiState({ signal }),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  const save = useCallback(
    async (fn: () => Promise<UiStateResponse>) => {
      try {
        const next = await fn();
        client.setQueryData(UI_STATE_QUERY_KEY, next);
      } catch {
        // The choice is a convenience; a failed write only means we may ask once more.
      }
    },
    [client],
  );
  return {
    shouldAsk: shouldAskBeforeApply(query.data?.state, jobId, hasTailoredResume),
    markShown: useCallback(() => save(() => dismiss([applyInterceptKey(jobId)])), [jobId, save]),
    neverAsk: useCallback(() => save(() => setUiValues({ [APPLY_INTERCEPT_NEVER]: true })), [save]),
  };
}
