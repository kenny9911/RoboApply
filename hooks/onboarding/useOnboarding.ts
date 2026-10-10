'use client';

// hooks/onboarding/useOnboarding.ts — onboarding queries and mutations (WP-30).
//
//   useOnboardingState()        GET  /onboarding/state (the stage machine's view)
//   useSaveStep()               PUT  /onboarding/steps/:step (reseeds the state)
//   useTitleSuggest(q)          GET  /onboarding/title-suggest (≥2 chars, debounced by the caller)
//   useMarketSnapshot(q)        GET  /onboarding/market-snapshot (title + country)
//   useOnboardingResumeSeed()   POST /onboarding/resume
//   useConfirmOnboarding()      POST /onboarding/confirm
//   useCompleteOnboarding()     POST /onboarding/complete (tour → done)
//   useLeaveOnboarding()        POST /onboarding/skip (leave early → finish banner)
//   useOnboardingMatch()        POST /onboarding/match (SSE; each phase arrives only when done)
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
  titles: (q: string, locale: string) => ['onboarding', 'titles', q, locale] as const,
  snapshot: (taxonomyId: string, country: string, city?: string) => ['onboarding', 'snapshot', taxonomyId, country, city ?? ''] as const,
};

export type OnboardingState = O.OnboardingStateView;

export function useOnboardingState(options: { enabled?: boolean } = {}) {
  return useQuery<OnboardingState>({
    queryKey: onboardingKeys.state(),
    queryFn: ({ signal }) => getOnboardingState({ signal }),
    enabled: options.enabled ?? true,
    staleTime: 60_000,
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
    onSuccess: () => qc.invalidateQueries({ queryKey: onboardingKeys.state() }),
  });
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

const PHASES = ['reading', 'saving', 'searching', 'comparing', 'ranking'] as const;
const freshPhases = (): MatchRunState['phases'] =>
  Object.fromEntries(PHASES.map((p) => [p, 'pending'])) as MatchRunState['phases'];

/** Runs O6 once per `start()`; a line is checked only when the server says that step finished. */
export function useOnboardingMatch() {
  const qc = useQueryClient();
  const [state, setState] = useState<MatchRunState>({ status: 'idle', phases: freshPhases(), result: null });
  const controller = useRef<AbortController | null>(null);

  useEffect(() => () => controller.current?.abort(), []);

  const start = useCallback(async () => {
    controller.current?.abort();
    const ac = new AbortController();
    controller.current = ac;
    setState({ status: 'running', phases: freshPhases(), result: null });
    let finished = false;
    try {
      await streamOnboardingMatch({
        signal: ac.signal,
        onEvent: (e) => {
          if (e.event === 'phase') {
            const { phase, skipped } = e.data;
            setState((s) => ({ ...s, phases: { ...s.phases, [phase]: skipped ? 'skipped' : 'done' } }));
          } else if (e.event === 'done') {
            finished = true;
            setState((s) => ({ ...s, status: 'done', result: e.data }));
          } else if (e.event === 'error') {
            finished = true;
            setState((s) => ({ ...s, status: 'error' }));
          }
        },
      });
      if (!finished && !ac.signal.aborted) setState((s) => ({ ...s, status: 'error' }));
      await qc.invalidateQueries({ queryKey: onboardingKeys.state() });
    } catch {
      if (!ac.signal.aborted) setState((s) => ({ ...s, status: 'error' }));
    }
  }, [qc]);

  return { ...state, start };
}
