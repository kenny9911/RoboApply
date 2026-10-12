'use client';

// hooks/resume/useResumeTour.ts — the 4-step resume check tour (WP-65;
// PRODUCT_PLAN.md F-RES-07). "Seen" lives in RAUserUiState (server-side, per
// user, every device). The first automatic start goes through the popup gate
// (one unprompted popup per page view, 24 h budget); "Show me around" replays
// it at any time (user-prompted, not a popup).

import { useCallback, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { getUiState, markToursSeen } from '../../lib/api/uiState';
import type { UiStateResponse } from '../../lib/api/contracts/uistate';
import { UI_STATE_QUERY_KEY, requestPopup } from '../../lib/ui/popupGate';

export const RESUME_TOUR_KEY = 'resume.checkTour';

export function useResumeTour(options: { enabled: boolean; autoStart?: boolean }) {
  const qc = useQueryClient();
  const ui = useQuery<UiStateResponse>({
    queryKey: UI_STATE_QUERY_KEY,
    queryFn: ({ signal }) => getUiState({ signal }),
    enabled: options.enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const seen = Boolean(ui.data?.state?.tours?.[RESUME_TOUR_KEY]);
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);

  const mark = useMutation<UiStateResponse, unknown, void>({
    mutationFn: () => markToursSeen([RESUME_TOUR_KEY]),
    onSuccess: (res) => qc.setQueryData(UI_STATE_QUERY_KEY, res),
  });

  // First visit: ask the popup gate once; a "no" leaves the replay button.
  useEffect(() => {
    if (!options.enabled || options.autoStart === false || !ui.isSuccess || seen) return;
    let cancelled = false;
    void requestPopup(`tour:${RESUME_TOUR_KEY}`, 'announcement').then((granted) => {
      if (!cancelled && granted) {
        setStep(0);
        setOpen(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [options.enabled, options.autoStart, ui.isSuccess, seen]);

  const start = useCallback(() => {
    setStep(0);
    setOpen(true);
  }, []);
  const finish = useCallback(() => {
    setOpen(false);
    if (!seen) mark.mutate();
  }, [mark, seen]);

  return { open, step, setStep, start, finish, seen, ready: ui.isSuccess || ui.isError };
}
