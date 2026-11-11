'use client';

// useDashboardFacts — the facts the Dashboard's meters are computed from
// (model.ts), read through the hooks the owning areas already use, so the
// dashboard shares their caches and never invents a number:
//
//   resumes        useResumeList (base vs tailored; the primary base resume)
//   resume check   useLatestResumeCheck on the primary resume (finished only)
//   cover letters  useCoverLetterList (first page; enough to know 0 vs ≥1)
//   profile        useProfile (completeness 0–100)
//   tracker        usePipelineBoard (status counts)
//   ready queue    useReadyQueue (being prepared or waiting for review; only
//                  with the `agent` capability)
//   practice       interviewEngineApi.recent (finished interviews)
//
// A query that fails or is still loading leaves its fact null, which the
// model renders as "not known" rather than as zero.

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';

import { useResumeList } from '../../../hooks/useResumes';
import { useLatestResumeCheck } from '../../../hooks/resume/useResumeCheck';
import { useCoverLetterList } from '../../../hooks/coverletter/useCoverLetters';
import { useProfile } from '../../../hooks/profile/useProfile';
import { usePipelineBoard } from '../../../hooks/usePipelineBoard';
import { useReadyQueue } from '../../../hooks/agent/useAgent';
import { useFlag } from '../../../lib/flags';
import { interviewEngineApi } from '../../../lib/api/interviewEngine';
import type { DashboardFacts } from './model';

export const dashboardKeys = {
  practiceRecent: ['dashboard', 'practice', 'recent'] as const,
};

/** Ready to apply queue states that mean "getting ready" (the queue's `ready` tab). */
export const PREPARING_QUEUE_STATES: readonly string[] = ['preparing', 'ready_for_review', 'approved'];

export function useDashboardFacts(): DashboardFacts {
  const resumes = useResumeList();
  const list = resumes.data?.resumes ?? null;
  const bases = useMemo(() => (list ? list.filter((r) => r.kind !== 'tailored_for_jd') : null), [list]);
  const primary = bases ? (bases.find((r) => r.isPrimary) ?? bases[0] ?? null) : null;

  const check = useLatestResumeCheck(primary?.id ?? null);
  const grade = check.data?.grade ?? null;
  const resumeScore = grade && grade.status === 'done' && typeof grade.score === 'number' ? grade.score : null;

  const letters = useCoverLetterList();
  const letterItems = letters.data?.pages?.[0]?.items;

  const profile = useProfile();
  const board = usePipelineBoard();
  const agentOn = useFlag('agent');
  const queue = useReadyQueue({ enabled: agentOn });
  const queueItems = agentOn ? queue.data?.items : undefined;

  const practice = useQuery({
    queryKey: dashboardKeys.practiceRecent,
    queryFn: () => interviewEngineApi.recent(),
    staleTime: 60_000,
    retry: false,
  });
  const sessions = practice.data?.sessions;

  return useMemo<DashboardFacts>(
    () => ({
      hasResume: bases === null ? null : bases.length > 0,
      primaryResumeId: primary?.id ?? null,
      resumeScore,
      tailoredCount: list === null ? null : list.filter((r) => r.kind === 'tailored_for_jd').length,
      letterCount: Array.isArray(letterItems) ? letterItems.length : null,
      profileCompleteness: typeof profile.data?.completeness === 'number' ? profile.data.completeness : null,
      statusCounts: board.data?.statusCounts ?? null,
      preparingCount: Array.isArray(queueItems) ? queueItems.filter((i) => PREPARING_QUEUE_STATES.includes(i.state)).length : null,
      practiceCompleted: Array.isArray(sessions) ? sessions.filter((s) => s.status === 'completed').length : null,
    }),
    [bases, primary?.id, resumeScore, list, letterItems, profile.data?.completeness, board.data?.statusCounts, queueItems, sessions],
  );
}
