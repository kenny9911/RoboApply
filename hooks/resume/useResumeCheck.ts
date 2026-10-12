'use client';

// hooks/resume/useResumeCheck.ts — resume check state (WP-22).
//
//   const check = useResumeCheck(resumeId);
//   check.latest.data        → { grade, previous, stale, aiAvailable }
//   await check.run()        → runs the check (the AI pass spends a resume_check credit;
//                              with none left the free checklist still runs and
//                              grade.aiSkipped says 'credits_exhausted')
//   await check.cancel()     → aborts the request and cancels the running check (credit back)
//
//   const fix = useIssueFix(resumeId);
//   await fix.write(issueId, 'shorter', instruction?)  → AI versions (credit `rewrite`)
//   await fix.apply(issueId, text)                     → writes the text into the resume
//
// API calls go through lib/api/resumes.ts only.

import { useCallback, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { applyIssueFix, cancelGrade, fixIssue, getLatestGrade, startGrade } from '../../lib/api/resumes';
import { apiErrorCode, apiErrorDetails, newIdempotencyKey } from '../../lib/api/contracts/wire';
import type { FixIssueResponse, GradeView, LatestGradeResponse } from '../../lib/api/contracts/resume';
import { useCreditGate } from '../shared/useCreditGate';
import { useInvalidateCredits } from '../shared/useCredits';

export const resumeCheckKeys = {
  all: ['resume-check'] as const,
  latest: (id: string) => ['resume-check', 'latest', id] as const,
};

export type ResumeCheckErrorKind = 'credits_exhausted' | 'ai_unavailable' | 'already_running' | 'not_found' | 'failed';

/** Map a failed call to a small set of UI states. */
export function resumeCheckErrorKind(err: unknown): ResumeCheckErrorKind {
  const code = apiErrorCode(err);
  if (code === 'credits_exhausted') return 'credits_exhausted';
  if (code === 'ai_unavailable') return 'ai_unavailable';
  if (code === 'not_found') return 'not_found';
  if (code === 'conflict') {
    const reason = apiErrorDetails<{ reason?: string }>(err)?.reason;
    if (reason === 'request_in_progress') return 'already_running';
  }
  return 'failed';
}

/** How often a check that is still running is polled (a reload mid-check, another tab, the onboarding worker). */
export const RUNNING_POLL_MS = 3_000;

/** The refetch interval for the latest-check query: poll only while a check is running. */
export function latestRefetchInterval(data: LatestGradeResponse | undefined): number | false {
  return data?.grade?.status === 'running' ? RUNNING_POLL_MS : false;
}

export function useLatestResumeCheck(id: string | null | undefined) {
  return useQuery<LatestGradeResponse>({
    queryKey: id ? resumeCheckKeys.latest(id) : ['resume-check', 'latest', 'none'],
    queryFn: ({ signal }) => getLatestGrade(id as string, { signal }),
    enabled: Boolean(id),
    staleTime: 30_000,
    refetchInterval: (q) => latestRefetchInterval(q.state.data),
  });
}

export interface ResumeCheckState {
  latest: ReturnType<typeof useLatestResumeCheck>;
  /** True while a check request is in flight. */
  running: boolean;
  /** Last run error, or null. */
  error: ResumeCheckErrorKind | null;
  /** Run (or re-run) the check. Resolves with the finished check, or null when it did not finish. */
  run(targetTitle?: string): Promise<GradeView | null>;
  /** Abort the in-flight check and cancel it server-side (the credit is given back). */
  cancel(): Promise<void>;
  /** Credits left for the AI pass (null = unknown). */
  creditsLeft: number | null;
}

export function useResumeCheck(id: string): ResumeCheckState {
  const qc = useQueryClient();
  const latest = useLatestResumeCheck(id);
  const gate = useCreditGate('resume_check');
  const invalidateCredits = useInvalidateCredits();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<ResumeCheckErrorKind | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const refresh = useCallback(() => qc.invalidateQueries({ queryKey: resumeCheckKeys.latest(id) }), [qc, id]);

  const run = useCallback(
    async (targetTitle?: string): Promise<GradeView | null> => {
      if (abortRef.current) return null;
      const controller = new AbortController();
      abortRef.current = controller;
      setRunning(true);
      setError(null);
      const body = targetTitle ? { targetTitle } : {};
      try {
        // Never blocked on credits: the server runs the free checklist and only
        // skips the AI pass when no resume_check credit is left (grade.aiSkipped).
        const res = await startGrade(id, body, { idempotencyKey: newIdempotencyKey(), signal: controller.signal });
        return res.grade ?? null;
      } catch (err) {
        if (controller.signal.aborted) return null;
        setError(resumeCheckErrorKind(err));
        return null;
      } finally {
        abortRef.current = null;
        setRunning(false);
        void refresh();
        if (latest.data?.aiAvailable !== false) void invalidateCredits();
      }
    },
    [id, invalidateCredits, latest.data?.aiAvailable, refresh],
  );

  const cancel = useCallback(async () => {
    abortRef.current?.abort();
    // The grade row exists server-side as soon as the check starts: find the
    // running one and cancel it so its reserved credit is released.
    try {
      const now = await getLatestGrade(id);
      if (now.grade?.status === 'running') await cancelGrade(now.grade.id);
    } catch {
      /* best effort: an abandoned reservation is released by the server's maintenance job */
    } finally {
      void refresh();
    }
  }, [id, refresh]);

  return { latest, running, error, run, cancel, creditsLeft: gate.left };
}

export type FixVariant = 'ai' | 'longer' | 'shorter' | 'stronger';

export interface IssueFixState {
  write(issueId: string, variant: FixVariant, instruction?: string): Promise<{ ok: true; value: FixIssueResponse } | { ok: false; error: IssueFixError }>;
  apply(issueId: string, text: string): Promise<boolean>;
  creditsLeft: number | null;
}

export type IssueFixError = 'credits_exhausted' | 'ai_unavailable' | 'citation_guard' | 'changed' | 'failed';

export function issueFixErrorKind(err: unknown): IssueFixError {
  const code = apiErrorCode(err);
  if (code === 'ai_unavailable') return 'ai_unavailable';
  if (code === 'credits_exhausted') return 'credits_exhausted';
  if (code === 'conflict') {
    const reason = apiErrorDetails<{ reason?: string }>(err)?.reason;
    if (reason === 'citation_guard') return 'citation_guard';
    if (reason === 'target_changed') return 'changed';
  }
  return 'failed';
}

export function useIssueFix(id: string): IssueFixState {
  const qc = useQueryClient();
  const gate = useCreditGate('rewrite');
  const applyMut = useMutation({
    mutationFn: ({ issueId, text }: { issueId: string; text: string }) => applyIssueFix(id, issueId, { text }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: resumeCheckKeys.latest(id) });
      void qc.invalidateQueries({ queryKey: ['v2', 'resumes'] });
    },
  });

  const write = useCallback<IssueFixState['write']>(
    async (issueId, variant, instruction) => {
      try {
        const r = await gate.run((idempotencyKey) => fixIssue(id, issueId, { variant, ...(instruction ? { instruction } : {}) }, { idempotencyKey }));
        if (!r.ok) return { ok: false, error: 'credits_exhausted' };
        return { ok: true, value: r.value };
      } catch (err) {
        return { ok: false, error: issueFixErrorKind(err) };
      }
    },
    [gate, id],
  );

  const apply = useCallback(
    async (issueId: string, text: string) => {
      try {
        await applyMut.mutateAsync({ issueId, text });
        return true;
      } catch {
        return false;
      }
    },
    [applyMut],
  );

  return { write, apply, creditsLeft: gate.left };
}
