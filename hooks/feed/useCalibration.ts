'use client';

// hooks/feed/useCalibration.ts — in-feed calibration (PRODUCT F-FEED-09,
// §4.3 O8 items 3–4; F-GROW-07): the feed rating card, the skills check and
// the "Looks better / Not quite" check after the Assistant changed filters.
//
// Every one of them is an unprompted prompt, so each asks lib/ui/popupGate.ts
// for the page view's one slot (24 h budget); none shows two at once.
//
//   rating       after 10 cards were on screen; once a day (the server also
//                answers 409 `feed_rating_already_today`). Dismissed ("Not
//                now") or rated → `dismiss(['feed.rating'])` in ui-state at
//                once — a rating is marked the moment the server accepts it,
//                not when its follow-up fixes close, so a list reload (a saved
//                fix changes the search) never asks again.
//   skills check only in a view where the rating is already done today, so
//                the two never compete; dismissed for 7 days.
//   after change set by the Assistant (WP-51) through
//                `noteAssistantFilterChange()`; shown on the next /jobs view.

import { useEffect, useState, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { getSkillsCheck } from '../../lib/api/feed';
import { getUiState, dismiss as dismissUi } from '../../lib/api/uiState';
import type { FilterSet } from '../../lib/api/contracts/search';
import { UI_STATE_QUERY_KEY, usePopupGate } from '../../lib/ui/popupGate';
import { createStore } from '../shared/store';
import { feedKeys } from './keys';

/** Cards seen before the rating card may ask (PRODUCT §4.3 O8 item 3). */
export const RATING_AFTER_CARDS = 10;
export const RATING_DISMISS_KEY = 'feed.rating';
export const SKILLS_DISMISS_KEY = 'feed.skillsCheck';
export const SKILLS_QUIET_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/** True when an ISO time falls on the same local calendar day as `now`. Pure. */
export function sameLocalDay(iso: string | null | undefined, now: Date = new Date()): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}

/** True when an ISO time is less than `days` days before `now`. Pure. */
export function within(iso: string | null | undefined, days: number, now: number = Date.now()): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && now - t < days * DAY_MS;
}

function useUiState(enabled: boolean) {
  return useQuery({
    queryKey: UI_STATE_QUERY_KEY,
    queryFn: ({ signal }) => getUiState({ signal }),
    enabled,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
}

export interface CalibrationState {
  rating: {
    show: boolean;
    /** "Not now" (or the server says it was already rated today). */
    close: () => void;
    /** The server accepted today's rating. */
    markRated: () => void;
  };
  skills: { show: boolean; close: () => void };
}

/**
 * Decides which calibration prompt this view may show.
 * `seenCount` = distinct cards that have been on screen in this view.
 */
export function useCalibration({ seenCount, enabled }: { seenCount: number; enabled: boolean }): CalibrationState {
  const qc = useQueryClient();
  const ui = useUiState(enabled);
  const [closed, setClosed] = useState<{ rating: boolean; skills: boolean }>({ rating: false, skills: false });
  const loaded = ui.isSuccess || ui.isError;
  const dismissals = ui.data?.state?.dismissals ?? {};
  const ratedToday = sameLocalDay(dismissals[RATING_DISMISS_KEY]?.at);
  const skillsQuiet = within(dismissals[SKILLS_DISMISS_KEY]?.at, SKILLS_QUIET_DAYS);

  const ratingWanted = enabled && loaded && !ratedToday && seenCount >= RATING_AFTER_CARDS;
  const ratingGate = usePopupGate('feed:rating', 'survey', { enabled: ratingWanted });

  const skillsQuery = useQuery({
    queryKey: feedKeys.skillsCheck(),
    queryFn: ({ signal }) => getSkillsCheck({ signal }),
    enabled: enabled && loaded && ratedToday && !skillsQuiet,
    staleTime: 30 * 60 * 1000,
    retry: false,
  });
  const hasSkills = (skillsQuery.data?.skills ?? []).some((s) => s.outOf > 0);
  const skillsGate = usePopupGate('feed:skills', 'survey', { enabled: enabled && loaded && ratedToday && !skillsQuiet && hasSkills });

  const remember = (key: string) => {
    void dismissUi([key])
      .then((res) => qc.setQueryData(UI_STATE_QUERY_KEY, res))
      .catch(() => undefined);
  };

  const doneRating = () => {
    setClosed((c) => ({ ...c, rating: true }));
    remember(RATING_DISMISS_KEY);
  };

  return {
    rating: {
      show: ratingGate.granted && !closed.rating,
      close: doneRating,
      markRated: doneRating,
    },
    skills: {
      show: skillsGate.granted && !closed.skills && hasSkills,
      close: () => {
        setClosed((c) => ({ ...c, skills: true }));
        remember(SKILLS_DISMISS_KEY);
      },
    },
  };
}

export function useSkillsCheckData(enabled: boolean) {
  return useQuery({
    queryKey: feedKeys.skillsCheck(),
    queryFn: ({ signal }) => getSkillsCheck({ signal }),
    enabled,
    staleTime: 30 * 60 * 1000,
    retry: false,
  });
}

// ── "Looks better / Not quite" after an Assistant filter change ──────────

export interface AssistantFilterChange {
  searchProfileId: string;
  /** The filters before the Assistant's change (for "Not quite" → put them back). */
  before: FilterSet;
  at: number;
}

const assistantChange = createStore<AssistantFilterChange | null>(null);

/**
 * Called by the Assistant (WP-51) after the user confirmed a filter change it
 * proposed. The next /jobs view asks "Looks better / Not quite".
 */
export function noteAssistantFilterChange(change: Omit<AssistantFilterChange, 'at'>): void {
  assistantChange.set(() => ({ ...change, at: Date.now() }));
}

export function clearAssistantFilterChange(): void {
  assistantChange.set(() => null);
}

export function useAssistantFilterChange(): AssistantFilterChange | null {
  return useSyncExternalStore(assistantChange.subscribe, assistantChange.get, () => null);
}

/** Tests only. */
export const __assistantChangeStore = assistantChange;

// ── Cards seen in this view ──────────────────────────────────────────────

/**
 * Counts distinct job ids reported as seen. Resets when `resetKey` changes
 * (a new list). Returns [count, markSeen].
 */
export function useSeenCounter(resetKey: string): [number, (jobId: string) => void] {
  const [state, setState] = useState<{ key: string; ids: Set<string> }>({ key: resetKey, ids: new Set() });
  useEffect(() => {
    setState((s) => (s.key === resetKey ? s : { key: resetKey, ids: new Set() }));
  }, [resetKey]);
  const mark = (jobId: string) =>
    setState((s) => {
      if (s.ids.has(jobId)) return s;
      const ids = new Set(s.ids);
      ids.add(jobId);
      return { key: s.key, ids };
    });
  return [state.ids.size, mark];
}
