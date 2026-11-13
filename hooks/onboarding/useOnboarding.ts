'use client';

// hooks/onboarding/useOnboarding.ts — onboarding queries and mutations (WP-30).
//
//   useOnboardingState()        GET  /onboarding/state (the stage machine's view; `pollWhileSearching`
//                               reads it again while the setup search is at work)
//   useSaveStep()               PUT  /onboarding/steps/:step (reseeds the state)
//   useTitleSuggest(q)          GET  /onboarding/title-suggest (≥2 chars, debounced by the caller)
//   useMarketSnapshot(q)        GET  /onboarding/market-snapshot (title + country)
//   useOnboardingResumeSeed()   POST /onboarding/resume
//   useResumeSeedResult()       that request's last answer in this session (read only)
//   useConfirmOnboarding()      POST /onboarding/confirm
//   useCompleteOnboarding()     POST /onboarding/complete (tour → done)
//   useLeaveOnboarding()        POST /onboarding/skip (leave early → finish banner)
//   useOnboardingMatch()        POST /onboarding/match (SSE; each phase arrives only when done)
//
// The save sequence of the two-screen start (/onboarding/start) is in
// ./useExpressOnboarding.ts.
//
// All requests go through lib/api/onboarding.ts. Analytics go through
// lib/analytics `track()` (first-party, consent-aware).

import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  completeOnboarding,
  confirmOnboarding,
  getMarketSnapshot,
  getOnboardingState,
  putOnboardingStep,
  skipOnboarding,
  streamOnboardingMatch,
  submitOnboardingResume,
  suggestTitles,
} from '../../lib/api/onboarding';
import type * as O from '../../lib/api/contracts/onboarding';
import { apiErrorCode } from '../../lib/api/contracts/wire';
import { track } from '../../lib/analytics';

export const onboardingKeys = {
  all: ['onboarding'] as const,
  state: () => ['onboarding', 'state'] as const,
  /** The last answer of POST /onboarding/resume in this session (set by the seed mutation; never fetched). */
  resumeSeed: () => ['onboarding', 'resumeSeed'] as const,
  titles: (q: string, locale: string) => ['onboarding', 'titles', q, locale] as const,
  snapshot: (taxonomyId: string, country: string, city?: string) => ['onboarding', 'snapshot', taxonomyId, country, city ?? ''] as const,
};

export type OnboardingState = O.OnboardingStateView;

/** How often a screen waiting on the setup search reads the state again while the server says it is at work. */
export const SEARCH_POLL_MS = 5_000;

/**
 * Read the state again every `SEARCH_POLL_MS` while it says the setup search
 * is at work (`searchRunning`), and stop once it is not. Pure, for tests.
 */
export function searchPollInterval(state: Pick<OnboardingState, 'searchRunning'> | undefined): number | false {
  return state?.searchRunning === true ? SEARCH_POLL_MS : false;
}

export function useOnboardingState(options: { enabled?: boolean; pollWhileSearching?: boolean } = {}) {
  const poll = options.pollWhileSearching === true;
  return useQuery<OnboardingState>({
    queryKey: onboardingKeys.state(),
    queryFn: ({ signal }) => getOnboardingState({ signal }),
    enabled: options.enabled ?? true,
    staleTime: 60_000,
    // Only a screen that waits on the search asks again (the Dashboard's Job search lane); the setup screens never do.
    refetchInterval: poll ? (q) => searchPollInterval(q.state.data) : false,
  });
}

export interface SaveStepInput {
  step: string;
  body: Record<string, unknown>;
}

export function useSaveStep() {
  const qc = useQueryClient();
  return useMutation<O.StepResponse, unknown, SaveStepInput>({
    mutationFn: ({ step, body }) => putOnboardingStep(step, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: onboardingKeys.state() }),
  });
}

export function useTitleSuggest(q: string, locale: string) {
  const query = q.trim();
  return useQuery({
    queryKey: onboardingKeys.titles(query.toLowerCase(), locale),
    queryFn: ({ signal }) => suggestTitles({ q: query, locale }, { signal }),
    enabled: query.length >= 2,
    staleTime: 5 * 60_000,
  });
}

export function useMarketSnapshot(input: { taxonomyId?: string | null; country?: string | null; city?: string | null }) {
  const enabled = !!input.taxonomyId && !!input.country && /^[A-Z]{2}$/.test(input.country);
  return useQuery<O.MarketSnapshotResponse>({
    queryKey: onboardingKeys.snapshot(input.taxonomyId ?? '', input.country ?? '', input.city ?? undefined),
    queryFn: ({ signal }) =>
      getMarketSnapshot({ taxonomyId: input.taxonomyId!, country: input.country!, ...(input.city ? { city: input.city } : {}) }, { signal }),
    enabled,
    staleTime: 30 * 60_000,
  });
}

export function useOnboardingResumeSeed() {
  const qc = useQueryClient();
  return useMutation<O.OnboardingResumeResponse, unknown, string>({
    mutationFn: (resumeVariantId) => submitOnboardingResume({ resumeVariantId }),
    onSuccess: (res, resumeVariantId) => {
      // Kept for the screen that asked (the start flow fills its fields from
      // it), so the answer is never requested twice: each request spends one
      // of the day's resume uses.
      qc.setQueryData<O.OnboardingResumeSuggestions>(onboardingKeys.resumeSeed(), { ...res, resumeVariantId });
      return qc.invalidateQueries({ queryKey: onboardingKeys.state() });
    },
  });
}

/**
 * What POST /onboarding/resume last answered in this session, with the resume
 * it was for; null before any answer. Never fetched: the seed mutation sets it.
 */
export function useResumeSeedResult(): O.OnboardingResumeSuggestions | null {
  const query = useQuery<O.OnboardingResumeSuggestions | null>({
    queryKey: onboardingKeys.resumeSeed(),
    queryFn: () => null,
    enabled: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
  return query.data ?? null;
}

export function useConfirmOnboarding() {
  const qc = useQueryClient();
  return useMutation<O.OnboardingStageResponse, unknown, Record<string, unknown>>({
    mutationFn: (body) => confirmOnboarding(body as Parameters<typeof confirmOnboarding>[0]),
    onSuccess: () => qc.invalidateQueries({ queryKey: onboardingKeys.state() }),
  });
}

export function useCompleteOnboarding() {
  const qc = useQueryClient();
  return useMutation<O.OnboardingStageResponse, unknown, void>({
    mutationFn: () => completeOnboarding(),
    onSuccess: () => qc.invalidateQueries({ queryKey: onboardingKeys.state() }),
  });
}

export function useLeaveOnboarding() {
  const qc = useQueryClient();
  return useMutation<O.OnboardingStageResponse, unknown, { stage: string; branch: string | null }>({
    mutationFn: () => skipOnboarding(),
    onSuccess: (_res, v) => {
      track('onboarding_abandoned', { stage: v.stage, branch: v.branch });
      return qc.invalidateQueries({ queryKey: onboardingKeys.state() });
    },
  });
}

/** Plain-language reason for a failed onboarding write. */
export function onboardingErrorReason(err: unknown): 'rate_limited' | 'invalid' | 'conflict' | 'unavailable' | 'unknown' {
  const code = apiErrorCode(err);
  if (code === 'rate_limited') return 'rate_limited';
  if (code === 'invalid_request') return 'invalid';
  if (code === 'conflict') return 'conflict';
  if (code === 'not_implemented' || code === 'feature_disabled' || code === 'ai_unavailable') return 'unavailable';
  return 'unknown';
}

// ── O6 matching stream ─────────────────────────────────────────────────────

export type MatchPhaseState = 'pending' | 'done' | 'skipped';
export interface MatchRunState {
  status: 'idle' | 'running' | 'done' | 'error';
  phases: Record<O.OnboardingMatchPhase, MatchPhaseState>;
  result: { jobCount: number; topJobIds: string[]; continuedInBackground: boolean } | null;
}

/**
 * How one run ended, for a caller that awaits `start()`:
 * `done` (the server's result), `error` (the stream failed, said so, or ended
 * without a result), or `aborted` (a newer run or an unmount cancelled it).
 */
export type MatchOutcome =
  | { status: 'done'; result: NonNullable<MatchRunState['result']> }
  | { status: 'error' }
  | { status: 'aborted' };

export interface MatchStartOptions {
  /**
   * The search outlives this screen: leaving the page does not cancel it (the
   * start flow finishes setup while the search runs on, and the Dashboard
   * waits for its picks). Only a newer `start()` cancels it.
   */
  outliveScreen?: boolean;
  /** Each line as the server reports it, for a caller that goes on before the run ends. */
  onPhase?: (phase: O.OnboardingMatchPhase, skipped: boolean) => void;
}

const PHASES = ['reading', 'saving', 'searching', 'comparing', 'ranking'] as const;
const freshPhases = (): MatchRunState['phases'] =>
  Object.fromEntries(PHASES.map((p) => [p, 'pending'])) as MatchRunState['phases'];

/**
 * Runs O6 once per `start()`; a line is checked only when the server says that
 * step finished. `start()` resolves with how the run ended (the state says the
 * same; the returned value is for a caller that goes on after the run). When
 * the stream ends the state is read again, wherever the user is by then.
 */
export function useOnboardingMatch() {
  const qc = useQueryClient();
  const [state, setState] = useState<MatchRunState>({ status: 'idle', phases: freshPhases(), result: null });
  const controller = useRef<AbortController | null>(null);
  /** The current run goes on after this screen is gone (`outliveScreen`). */
  const outlives = useRef(false);

  useEffect(
    () => () => {
      if (!outlives.current) controller.current?.abort();
    },
    [],
  );

  const start = useCallback(async (options: MatchStartOptions = {}): Promise<MatchOutcome> => {
    controller.current?.abort();
    const ac = new AbortController();
    controller.current = ac;
    outlives.current = options.outliveScreen === true;
    setState({ status: 'running', phases: freshPhases(), result: null });
    // What the stream said last (set from its callback).
    const ended: { outcome: MatchOutcome | null } = { outcome: null };
    try {
      await streamOnboardingMatch({
        signal: ac.signal,
        onEvent: (e) => {
          if (e.event === 'phase') {
            const { phase, skipped } = e.data;
            setState((s) => ({ ...s, phases: { ...s.phases, [phase]: skipped ? 'skipped' : 'done' } }));
            options.onPhase?.(phase, skipped === true);
          } else if (e.event === 'done') {
            ended.outcome = { status: 'done', result: e.data };
            setState((s) => ({ ...s, status: 'done', result: e.data }));
          } else if (e.event === 'error') {
            ended.outcome = { status: 'error' };
            setState((s) => ({ ...s, status: 'error' }));
          }
        },
      });
      if (!ended.outcome && !ac.signal.aborted) setState((s) => ({ ...s, status: 'error' }));
      await qc.invalidateQueries({ queryKey: onboardingKeys.state() });
      return ended.outcome ?? (ac.signal.aborted ? { status: 'aborted' } : { status: 'error' });
    } catch {
      if (ac.signal.aborted) return { status: 'aborted' };
      setState((s) => ({ ...s, status: 'error' }));
      return { status: 'error' };
    }
  }, [qc]);

  return { ...state, start };
}
