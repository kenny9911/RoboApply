'use client';

// hooks/copilot/useRailMemory.ts — what the Assistant remembers about its
// entry points across devices (RAUserUiState): the floating button being
// hidden (`dismissals['assistant.fab']`) (WP-51; PRODUCT_PLAN.md §3.3 "remembers
// dismissal; never auto-opens on route change").
//
// The rail itself is NOT reopened on a page load. It used to be: when the user
// had left it open, the next full page load opened it again a few seconds
// later (once the stored state arrived). The rail is a modal drawer with a
// scrim, so that put a dialog over the page the user had just started using,
// blocked its clicks, and stacked on first-visit banners. The rail now opens
// only when the user asks (Ask, the floating button, Cmd/Ctrl+J, an "Ask about
// this" button); the conversation is still there when they do (threads are
// stored, and the open chat lives in the app shell).
//
// `RAIL_VALUE_KEY` is no longer written. A value stored by an older build is
// ignored (the server keeps unknown values; nothing reads this one).

import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { dismiss as dismissUi, getUiState, undismiss as undismissUi, type UiStateResponse } from '../../lib/api/uiState';
import { UI_STATE_QUERY_KEY } from '../../lib/ui/popupGate';

/** The ui-state value older builds wrote ('open' | 'closed'). Not read, not written. */
export const RAIL_VALUE_KEY = 'assistant.rail';
export const FAB_DISMISS_KEY = 'assistant.fab';

export function useUiStateQuery(enabled: boolean) {
  return useQuery({
    queryKey: UI_STATE_QUERY_KEY,
    queryFn: ({ signal }) => getUiState({ signal }),
    enabled,
    retry: false,
    staleTime: 5 * 60 * 1000,
  });
}

export interface RailMemory {
  /** The floating button was hidden by the user. Null while unknown. */
  fabHidden: boolean | null;
  hideFab: () => void;
  showFab: () => void;
}

export interface RailMemoryOptions {
  enabled: boolean;
}

export function useRailMemory({ enabled }: RailMemoryOptions): RailMemory {
  const qc = useQueryClient();
  const ui = useUiStateQuery(enabled);

  const fabHidden = ui.data ? (ui.data.state.dismissals[FAB_DISMISS_KEY]?.count ?? 0) > 0 : ui.isError ? false : null;

  const hideFab = useCallback(() => {
    qc.setQueryData<UiStateResponse>(UI_STATE_QUERY_KEY, (prev) =>
      prev ? { ...prev, state: { ...prev.state, dismissals: { ...prev.state.dismissals, [FAB_DISMISS_KEY]: { count: 1, at: new Date().toISOString() } } } } : prev,
    );
    dismissUi([FAB_DISMISS_KEY])
      .then((res) => qc.setQueryData(UI_STATE_QUERY_KEY, res))
      .catch(() => undefined);
  }, [qc]);

  const showFab = useCallback(() => {
    qc.setQueryData<UiStateResponse>(UI_STATE_QUERY_KEY, (prev) => {
      if (!prev) return prev;
      const { [FAB_DISMISS_KEY]: _gone, ...rest } = prev.state.dismissals;
      return { ...prev, state: { ...prev.state, dismissals: rest } };
    });
    undismissUi([FAB_DISMISS_KEY])
      .then((res) => qc.setQueryData(UI_STATE_QUERY_KEY, res))
      .catch(() => undefined);
  }, [qc]);

  return { fabHidden, hideFab, showFab };
}
