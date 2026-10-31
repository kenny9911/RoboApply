// components/features/resume/hub/hubModel.ts — what the /resume hub works out
// from data it already has: the resume list, the main resume's latest check and
// the user's saved jobs. Pure, so the order of "Up next" is testable.
//
// Nothing here is a model call or a guess (D3). Every step names something the
// server reported: claims still to verify on a tailored version, or the state
// of the last check. Saved jobs without a tailored version are offered by the
// AI tailoring panel, not listed here as well.

import type { GradeCounts, GradeLabel, LatestGradeResponse } from '../../../../lib/api/contracts/resume';
import { BASE_SLOT_KINDS, type ResumeSummary } from '../../../../lib/api/resumes';
import type { TailorTargetJob } from '../../../../hooks/tailor';

/** Base resumes take a slot; tailored versions do not (same rule as ResumeHub's isBaseSlot). */
const isBaseSlot = (r: Pick<ResumeSummary, 'kind'>): boolean => BASE_SLOT_KINDS.includes(r.kind);

/** Steps "Up next" shows at most. */
export const NEXT_STEP_LIMIT = 3;
/** Tailored versions with details to verify that get their own step. */
const VERIFY_STEP_LIMIT = 2;

/** One resume's latest check, as the hub shows it. */
export type CheckState =
  | { kind: 'loading' }
  /** The read failed: the hub says nothing rather than a made-up state. */
  | { kind: 'unknown' }
  | { kind: 'none' }
  | { kind: 'running' }
  | { kind: 'failed' }
  | {
      kind: 'done';
      label: GradeLabel | null;
      score: number | null;
      counts: GradeCounts | null;
      /** The resume changed after the check ran. */
      stale: boolean;
      checkedAt: string | null;
    };

export interface LatestCheckQuery {
  data?: LatestGradeResponse;
  isLoading: boolean;
  isError: boolean;
}

export function checkStateOf(q: LatestCheckQuery): CheckState {
  if (q.isLoading) return { kind: 'loading' };
  if (q.isError || !q.data) return { kind: 'unknown' };
  const grade = q.data.grade;
  if (!grade || grade.status === 'cancelled') return { kind: 'none' };
  if (grade.status === 'running') return { kind: 'running' };
  if (grade.status === 'failed') return { kind: 'failed' };
  return {
    kind: 'done',
    label: grade.label,
    score: grade.score,
    counts: grade.counts,
    stale: q.data.stale,
    checkedAt: grade.completedAt ?? grade.createdAt,
  };
}

/** Base resumes (they take a slot): the primary first, then the newest edit. */
export function sortBases(resumes: readonly ResumeSummary[]): ResumeSummary[] {
  return resumes
    .filter(isBaseSlot)
    .sort((a, b) => Number(Boolean(b.isPrimary)) - Number(Boolean(a.isPrimary)) || b.lastEditedAt.localeCompare(a.lastEditedAt));
}

/** The resume every job fit is read for: the primary, else the newest base. */
export function mainResumeOf(bases: readonly ResumeSummary[]): ResumeSummary | null {
  return bases.find((r) => r.isPrimary) ?? bases[0] ?? null;
}

/** Saved jobs that no tailored version was made for yet (tracker order kept). */
export function untailoredJobs(targets: readonly TailorTargetJob[], resumes: readonly ResumeSummary[]): TailorTargetJob[] {
  const tailored = new Set(resumes.filter((r) => !isBaseSlot(r) && r.targetJobId).map((r) => r.targetJobId as string));
  return targets.filter((j) => !tailored.has(j.jobId));
}

export type NextStep =
  | { kind: 'verify'; resumeId: string; name: string; count: number; sessionId: string | null }
  | { kind: 'check_running'; resumeId: string; name: string }
  | { kind: 'check_stale'; resumeId: string; name: string }
  | { kind: 'check_failed'; resumeId: string; name: string }
  | { kind: 'check_none'; resumeId: string; name: string }
  | { kind: 'fix_urgent'; resumeId: string; name: string; count: number }
  | { kind: 'fix_critical'; resumeId: string; name: string; count: number };

export interface NextStepsInput {
  resumes: readonly ResumeSummary[];
  /** The main resume and its latest check, or null when there is no base resume. */
  main: { resume: ResumeSummary; check: CheckState } | null;
}

/** The main resume's check, as one step (or none when nothing is pending). */
function checkStep(resume: ResumeSummary, check: CheckState): NextStep | null {
  const ref = { resumeId: resume.id, name: resume.name };
  switch (check.kind) {
    case 'running':
      return { kind: 'check_running', ...ref };
    case 'failed':
      return { kind: 'check_failed', ...ref };
    case 'none':
      return { kind: 'check_none', ...ref };
    case 'done': {
      // Issues found before an edit may already be fixed: check again first.
      if (check.stale) return { kind: 'check_stale', ...ref };
      const urgent = check.counts?.urgent ?? 0;
      if (urgent > 0) return { kind: 'fix_urgent', ...ref, count: urgent };
      const critical = check.counts?.critical ?? 0;
      if (critical > 0) return { kind: 'fix_critical', ...ref, count: critical };
      return null;
    }
    default:
      // loading / unknown: no step rather than a guess.
      return null;
  }
}

/**
 * What needs the user's attention, most pressing first:
 *   1. tailored versions with details to verify (their download waits on it);
 *   2. the main resume's check (running, edited since, failed, never run,
 *      issues to fix first, important issues).
 */
export function nextSteps({ resumes, main }: NextStepsInput, limit = NEXT_STEP_LIMIT): NextStep[] {
  const steps: NextStep[] = [];
  const toVerify = resumes
    .filter((r) => !isBaseSlot(r) && (r.unverifiedClaims ?? 0) > 0)
    .sort((a, b) => b.lastEditedAt.localeCompare(a.lastEditedAt))
    .slice(0, VERIFY_STEP_LIMIT);
  for (const r of toVerify) {
    steps.push({ kind: 'verify', resumeId: r.id, name: r.name, count: r.unverifiedClaims ?? 0, sessionId: r.tailorSessionId ?? null });
  }
  if (main) {
    const step = checkStep(main.resume, main.check);
    if (step) steps.push(step);
  }
  return steps.slice(0, limit);
}
