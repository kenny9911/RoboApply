'use client';

// hooks/copilot/useRailMemory.ts — the rail remembers open/closed across
// devices in RAUserUiState (`values['assistant.rail']`), and the floating
// button remembers being hidden (`dismissals['assistant.fab']`) (WP-51;
// PRODUCT_PLAN.md §3.3 "remembers dismissal; never auto-opens on route change").
//
// Rules:
//   • Navigation never opens the rail. The only restore is ONCE per app load
//     (a full page load), on a wide screen, when the user left it open; a
//     phone never gets a full-screen sheet it did not ask for.
//   • Open/close by the user is written back; the restore itself is not.
//   • The caller says whether a restore may happen here (`restore`): never on
//     /assistant (the full page is already the Assistant — the drawer would
//     put a second conversation over it) and never when the user cannot ask.
//     'skip' uses up the one restore of this load, so leaving /assistant later
//     does not open the rail (that would be opening on navigation); 'wait'
//     holds it until the answer is known (e.g. the GoApply consent check).

import { useCallback, useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { dismiss as dismissUi, getUiState, setUiValues, undismiss as undismissUi, type UiStateResponse } from '../../lib/api/uiState';
import { UI_STATE_QUERY_KEY } from '../../lib/ui/popupGate';
import { openAssistantRail } from '../shared/useOpenAssistant';

export const RAIL_VALUE_KEY = 'assistant.rail';
export const FAB_DISMISS_KEY = 'assistant.fab';
/** Wide enough for the drawer to sit beside the page (the primitives' 760px break). */
export const RAIL_RESTORE_QUERY = '(min-width: 761px)';

let restoredThisLoad = false;

/** Tests only. */
export function __resetRailRestore(): void {
  restoredThisLoad = false;
}

function isWide(): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(RAIL_RESTORE_QUERY).matches;
  } catch {
    return false;
  }
}

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
  /** The rail's open state (written back when `track`). */
  open: boolean;
  /** The rail itself: restore once per load and write changes back. Settings only reads the button state. */
  track?: boolean;
  /** Whether the one restore of this load may open the rail now. Default 'allow'. */
  restore?: 'allow' | 'skip' | 'wait';
}

export function useRailMemory({ enabled, open, track = true, restore = 'allow' }: RailMemoryOptions): RailMemory {
  const qc = useQueryClient();
  const ui = useUiStateQuery(enabled);
  const lastWritten = useRef<boolean | null>(null);
  const skipNext = useRef(true);

  // Restore once per app load.
  useEffect(() => {
    if (!enabled || !track || restoredThisLoad || !ui.data || restore === 'wait') return;
    restoredThisLoad = true;
    // The user already opened or closed it before the state arrived: theirs wins.
    if (lastWritten.current !== null) return;
    const wasOpen = ui.data.state.values[RAIL_VALUE_KEY] === 'open';
    lastWritten.current = wasOpen;
    if (wasOpen && restore === 'allow' && isWide()) openAssistantRail({ source: 'other' });
  }, [enabled, track, ui.data, restore]);

  // Write back user changes (not the first render, not the restore).
  useEffect(() => {
    if (!enabled || !track) return;
    if (skipNext.current) {
      skipNext.current = false;
      return;
    }
    if (lastWritten.current === open) return;
    lastWritten.current = open;
    setUiValues({ [RAIL_VALUE_KEY]: open ? 'open' : 'closed' })
      .then((res) => qc.setQueryData<UiStateResponse>(UI_STATE_QUERY_KEY, res))
      .catch(() => undefined);
  }, [enabled, track, open, qc]);

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
