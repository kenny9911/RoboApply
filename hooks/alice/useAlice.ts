'use client';

// hooks/alice/useAlice.ts — Alice, the application agent (docs/alice/ALICE.md).
//
//   useAliceThread        the conversation and its state (stage, brief, drafts, versions)
//   useAliceTurn          one action, streamed: the steps really running, each new
//                         message as it is stored, the whole thread at the end
//   useAliceProfiles      saved job profiles
//   useAliceMatches       the jobs that fit a saved profile
//   useAliceApplications  stage counts, what needs the person, follow-up dates
//   useAliceReminder      set or clear an application's follow-up date
//   usePatchAliceProfile  rename, archive, undo a search change
//
// The progress steps are the server's own events (a subagent or worker really
// running), never a timer. API calls go through lib/api/alice.ts only.

import { useCallback, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  aliceTurn,
  clearAliceReminder,
  getAliceApplications,
  getAliceMatches,
  getAliceThread,
  listAliceProfiles,
  patchAliceProfile,
  setAliceReminder,
} from '../../lib/api/alice';
import type * as AL from '../../lib/api/contracts/alice';
import { apiErrorCode, apiErrorReason, type In } from '../../lib/api/contracts/wire';

export const aliceKeys = {
  all: ['alice'] as const,
  thread: () => ['alice', 'thread'] as const,
  profiles: () => ['alice', 'profiles'] as const,
  matches: (profileId: string) => ['alice', 'matches', profileId] as const,
  applications: () => ['alice', 'applications'] as const,
};

export type AliceTurnBody = In<typeof AL.AliceTurnBodySchema>;

/** A failed turn or read, in the words the screen chooses from. */
export interface AliceError {
  code: string;
  reason: string | null;
  message: string;
}

export function aliceErrorOf(err: unknown): AliceError {
  return {
    code: apiErrorCode(err) ?? 'unknown',
    reason: apiErrorReason(err),
    message: err instanceof Error ? err.message : '',
  };
}

export function useAliceThread() {
  return useQuery({
    queryKey: aliceKeys.thread(),
    queryFn: ({ signal }) => getAliceThread({ signal }),
    staleTime: 30_000,
    // 503 alice_not_ready / ai_unavailable and 404 feature_disabled are answers, not glitches.
    retry: (count, err) => count < 2 && !['ai_unavailable', 'feature_disabled', 'not_found'].includes(apiErrorCode(err) ?? ''),
  });
}

export interface StepState {
  step: AL.AliceStep;
  state: 'running' | 'done';
}

/** Merge a streamed message into the cached thread (once, in order). */
function withMessage(thread: AL.AliceThreadView | undefined, message: AL.AliceMessageView): AL.AliceThreadView | undefined {
  if (!thread || thread.messages.some((m) => m.id === message.id)) return thread;
  return { ...thread, messages: [...thread.messages, message] };
}

/** Kinds whose result changes the other panels (saved profiles, the search, the applications board). */
const REFRESH_AFTER: ReadonlySet<AliceTurnBody['kind']> = new Set(['save', 'find_jobs', 'report', 'message', 'edit_profile', 'restart']);

export function useAliceTurn() {
  const qc = useQueryClient();
  const [running, setRunning] = useState<AliceTurnBody['kind'] | null>(null);
  const [steps, setSteps] = useState<StepState[]>([]);
  const [error, setError] = useState<AliceError | null>(null);
  const busy = useRef(false);

  const send = useCallback(
    async (body: AliceTurnBody): Promise<boolean> => {
      if (busy.current) return false;
      busy.current = true;
      setRunning(body.kind);
      setSteps([]);
      setError(null);
      try {
        const outcome = await aliceTurn(body, {
          onEvent: (e) => {
            if (e.event === 'progress') {
              setSteps((prev) => {
                const rest = prev.filter((s) => s.step !== e.data.step);
                return [...rest, { step: e.data.step, state: e.data.state }];
              });
            } else if (e.event === 'message') {
              qc.setQueryData<AL.AliceThreadView>(aliceKeys.thread(), (t) => withMessage(t, e.data.message));
            } else if (e.event === 'thread') {
              qc.setQueryData(aliceKeys.thread(), e.data.thread);
            }
          },
        });
        if (outcome.status === 'error') setError({ code: outcome.code, reason: outcome.reason ?? null, message: outcome.message });
        if (outcome.status === 'interrupted') {
          setError({ code: 'stream_interrupted', reason: null, message: '' });
          await qc.invalidateQueries({ queryKey: aliceKeys.thread() });
        }
        if (REFRESH_AFTER.has(body.kind)) {
          void qc.invalidateQueries({ queryKey: aliceKeys.profiles() });
          void qc.invalidateQueries({ queryKey: aliceKeys.applications() });
          void qc.invalidateQueries({ queryKey: ['alice', 'matches'] });
        }
        if (body.kind === 'save') void qc.invalidateQueries({ queryKey: ['search'] });
        return outcome.status === 'done';
      } catch (err) {
        setError(aliceErrorOf(err));
        return false;
      } finally {
        busy.current = false;
        setRunning(null);
      }
    },
    [qc],
  );

  return { send, running, steps, error, clearError: () => setError(null) };
}

export function useAliceProfiles(enabled = true) {
  return useQuery({ queryKey: aliceKeys.profiles(), queryFn: ({ signal }) => listAliceProfiles({ signal }), enabled, staleTime: 60_000 });
}

export function useAliceMatches(profileId: string | null) {
  return useQuery({
    queryKey: aliceKeys.matches(profileId ?? 'none'),
    queryFn: ({ signal }) => getAliceMatches(profileId!, undefined, { signal }),
    enabled: !!profileId,
    staleTime: 5 * 60_000,
  });
}

export function useAliceApplications(enabled = true) {
  return useQuery({ queryKey: aliceKeys.applications(), queryFn: ({ signal }) => getAliceApplications({ signal }), enabled, staleTime: 60_000 });
}

export function useAliceReminder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { entryId: string; date: string | null }) =>
      input.date ? setAliceReminder(input.entryId, { date: input.date }) : clearAliceReminder(input.entryId).then(() => null),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: aliceKeys.applications() });
      void qc.invalidateQueries({ queryKey: ['tracker'] });
    },
  });
}

export function usePatchAliceProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; body: In<typeof AL.AlicePatchProfileBodySchema> }) => patchAliceProfile(input.id, input.body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: aliceKeys.profiles() });
      void qc.invalidateQueries({ queryKey: aliceKeys.thread() });
      void qc.invalidateQueries({ queryKey: ['search'] });
    },
  });
}
