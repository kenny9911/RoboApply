'use client';

// lib/ui/popupGate.ts — the single arbiter for every unprompted modal, prompt
// and offer (ARCHITECTURE.md §8.5; PRODUCT_PLAN.md F-NOTIF-06; TASK_PLAN.md
// §2.2 "Popups").
//
// Rules:
//   1. At most ONE popup per page view (essential or not).
//   2. At least 24 h between NON-ESSENTIAL popups, across tabs and devices:
//      the last time is `RAUserUiState.popupLastShownAt` (stamped by the
//      server, so it cannot be back-dated), mirrored in localStorage so the
//      gap still holds when the ui-state API is unavailable.
//   3. When several popups ask during the same moment (a page mounting), the
//      highest priority wins: install prompt < announcement < survey <
//      extension prompt < offer. Requests are collected for a short window,
//      then decided once. The PWA install prompt is the lowest: it can wait
//      for any other day, while news, a survey or an offer is about now.
//   4. `essential` popups (a legal notice that must be acknowledged) skip the
//      24 h gap but still take the page view's one slot, and do not reset the
//      gap.
//
// A user-prompted dialog (the user clicked something) is NOT a popup and never
// goes through here. Toasts don't either.
//
//   const granted = await requestPopup('announcement:42', 'announcement');
//   if (granted) setOpen(true);
//
//   // or, in a component:
//   const { granted } = usePopupGate('extension:install', 'extension_prompt', { enabled: used });
//
// The app shell calls `notePageView(pathname)` on every route change and
// `usePopupGateSync()` once to seed the server's last-shown time.

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { getUiState, recordPopupShown } from '../api/uiState';

export type PopupPriority = 'install_prompt' | 'announcement' | 'survey' | 'extension_prompt' | 'offer';

/** Higher wins. */
export const POPUP_PRIORITY: Record<PopupPriority, number> = {
  install_prompt: 0,
  announcement: 1,
  survey: 2,
  extension_prompt: 3,
  offer: 4,
};

export const POPUP_GAP_MS = 24 * 60 * 60 * 1000;
/** Requests arriving within this window of the first are decided together. */
export const POPUP_ARBITRATION_MS = 50;
export const POPUP_STORAGE_KEY = 'ra_popup_last_shown_at';
/** React Query key of `GET /ui-state` (shared with anyone else reading it). */
export const UI_STATE_QUERY_KEY = ['ui-state'] as const;

export interface PopupRequestOptions {
  /** Skips the 24 h gap (still one per page view). Use only for notices that must be seen. */
  essential?: boolean;
}

interface Pending {
  key: string;
  priority: PopupPriority;
  essential: boolean;
  resolve: (granted: boolean) => void;
}

export interface PopupGateDeps {
  now: () => number;
  /** Read the locally mirrored last-shown time (ms) or null. */
  loadLocal: () => number | null;
  /** Mirror a last-shown time locally. */
  saveLocal: (ms: number) => void;
  /** Tell the server a non-essential popup was shown (fire and forget). */
  persist: () => void;
  /** Run `fn` after `ms` (tests pass a synchronous scheduler). */
  schedule: (fn: () => void, ms: number) => void;
  arbitrationMs?: number;
}

export interface PopupGateSnapshot {
  viewKey: string | null;
  /** The popup holding this view's slot, or null. */
  shownThisView: string | null;
  lastShownAt: number | null;
}

export interface PopupGate {
  request(key: string, priority: PopupPriority, options?: PopupRequestOptions): Promise<boolean>;
  /** A new page view (route change). Frees the slot; unresolved requests from the old view are denied. */
  notePageView(viewKey: string): void;
  /** Seed the server's last-shown time (ISO) — the later of server and local wins. */
  seedLastShownAt(iso: string | null | undefined): void;
  snapshot(): PopupGateSnapshot;
}

export function createPopupGate(deps: PopupGateDeps): PopupGate {
  const arbitrationMs = deps.arbitrationMs ?? POPUP_ARBITRATION_MS;
  let viewKey: string | null = null;
  let viewSeq = 0;
  let shownThisView: string | null = null;
  let lastShownAt: number | null = deps.loadLocal();
  let pending: Pending[] = [];
  let batchOpen = false;

  function gapOk(now: number): boolean {
    return lastShownAt === null || now - lastShownAt >= POPUP_GAP_MS;
  }

  function decide(seq: number) {
    batchOpen = false;
    const batch = pending;
    pending = [];
    if (seq !== viewSeq) {
      for (const p of batch) p.resolve(false);
      return;
    }
    const now = deps.now();
    // Rule 1: the slot is spent for the rest of the view, even after the popup closes.
    const slotFree = shownThisView === null;
    const eligible = slotFree ? batch.filter((p) => p.essential || gapOk(now)) : [];
    // Highest priority wins; essential beats non-essential at equal priority; first asked breaks ties.
    let winner: Pending | null = null;
    for (const p of eligible) {
      if (
        !winner ||
        POPUP_PRIORITY[p.priority] > POPUP_PRIORITY[winner.priority] ||
        (POPUP_PRIORITY[p.priority] === POPUP_PRIORITY[winner.priority] && p.essential && !winner.essential)
      ) {
        winner = p;
      }
    }
    if (winner) {
      shownThisView = winner.key;
      if (!winner.essential) {
        lastShownAt = now;
        deps.saveLocal(now);
        deps.persist();
      }
    }
    for (const p of batch) p.resolve(p === winner);
  }

  return {
    request(key, priority, options = {}) {
      return new Promise<boolean>((resolve) => {
        pending.push({ key, priority, essential: options.essential === true, resolve });
        if (!batchOpen) {
          batchOpen = true;
          const seq = viewSeq;
          deps.schedule(() => decide(seq), arbitrationMs);
        }
      });
    },
    notePageView(next) {
      if (next === viewKey) return;
      viewKey = next;
      viewSeq += 1;
      shownThisView = null;
    },
    seedLastShownAt(iso) {
      if (!iso) return;
      const ms = Date.parse(iso);
      if (!Number.isFinite(ms)) return;
      if (lastShownAt === null || ms > lastShownAt) {
        lastShownAt = ms;
        deps.saveLocal(ms);
      }
    },
    snapshot() {
      return { viewKey, shownThisView, lastShownAt };
    },
  };
}

// ── The app-wide gate ─────────────────────────────────────────────────────

function readLocal(): number | null {
  try {
    const raw = window.localStorage.getItem(POPUP_STORAGE_KEY);
    const ms = raw ? Number(raw) : NaN;
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

function writeLocal(ms: number): void {
  try {
    window.localStorage.setItem(POPUP_STORAGE_KEY, String(ms));
  } catch {
    /* private mode / blocked storage: the server copy still holds */
  }
}

let gate: PopupGate | null = null;

/** The shared gate (created on first use in the browser). */
export function getPopupGate(): PopupGate {
  if (!gate) {
    gate = createPopupGate({
      now: () => Date.now(),
      loadLocal: () => (typeof window === 'undefined' ? null : readLocal()),
      saveLocal: (ms) => {
        if (typeof window !== 'undefined') writeLocal(ms);
      },
      persist: () => {
        void recordPopupShown().catch(() => undefined);
      },
      schedule: (fn, ms) => {
        setTimeout(fn, ms);
      },
    });
  }
  return gate;
}

/** Tests only: replace (or reset with null) the shared gate. */
export function __setPopupGate(next: PopupGate | null): void {
  gate = next;
}

export function requestPopup(key: string, priority: PopupPriority, options?: PopupRequestOptions): Promise<boolean> {
  return getPopupGate().request(key, priority, options);
}

export function notePageView(viewKey: string): void {
  getPopupGate().notePageView(viewKey);
}

/** Ask for a slot when `enabled` turns true; `granted` stays true for this mount. */
export function usePopupGate(
  key: string,
  priority: PopupPriority,
  { enabled = true, essential = false }: { enabled?: boolean; essential?: boolean } = {},
): { granted: boolean } {
  const [granted, setGranted] = useState(false);
  useEffect(() => {
    if (!enabled || granted) return undefined;
    let live = true;
    void getPopupGate()
      .request(key, priority, { essential })
      .then((ok) => {
        if (live && ok) setGranted(true);
      });
    return () => {
      live = false;
    };
  }, [enabled, granted, key, priority, essential]);
  return { granted };
}

/** Seed the gate from the server's ui-state once per session (the shell calls it). */
export function usePopupGateSync(enabled: boolean = true): void {
  const query = useQuery({
    queryKey: UI_STATE_QUERY_KEY,
    queryFn: ({ signal }) => getUiState({ signal }),
    enabled,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  const iso = query.data?.state?.popupLastShownAt ?? null;
  useEffect(() => {
    if (iso) getPopupGate().seedLastShownAt(iso);
  }, [iso]);
}
