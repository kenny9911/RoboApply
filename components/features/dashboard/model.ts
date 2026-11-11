// components/features/dashboard/model.ts — the Dashboard's goals and steps,
// pure (no React, no I/O), so the progress rules are testable.
//
// The page follows resume.io's dashboard (docs/resume-io/TEARDOWN.md, "The
// dashboard"): four goal tabs, each a short list of steps with a progress
// meter, and one call to action for the selected step. resume.io's meters
// come from its own stepper service; ours are computed here from facts the
// signed-in user already has on the server (their resumes, latest resume
// check, cover letters, profile, tracker and practice interviews).
//
// Two kinds of step:
//   percent  the value IS a percentage the server reports (resume check
//            score, profile completeness); the bar fills to it.
//   count    the value is a real count; the bar fills toward STEP_TARGETS,
//            a goal the dashboard sets (like resume.io's target_score). The
//            row shows "count/target", so the goal is never hidden.
// An unknown fact (still loading, or the area is off) is null and the row
// says nothing rather than showing a zero it does not know.

export const GOALS = ['resume', 'jobs', 'applications', 'interview'] as const;
export type GoalId = (typeof GOALS)[number];

export const GOAL_STEPS = {
  resume: ['resume_check', 'tailored', 'letters'],
  jobs: ['profile', 'saved'],
  applications: ['preparing', 'applied', 'interviews'],
  interview: ['practice'],
} as const satisfies Record<GoalId, readonly string[]>;

export type StepId = (typeof GOAL_STEPS)[GoalId][number];

export const ALL_STEPS: readonly StepId[] = GOALS.flatMap((g) => GOAL_STEPS[g]);

/** Count goals the bars measure against. Shown in the row as "n/target". */
export const STEP_TARGETS = {
  tailored: 3,
  letters: 1,
  saved: 5,
  preparing: 3,
  applied: 5,
  interviews: 1,
  practice: 3,
} as const satisfies Partial<Record<StepId, number>>;

/** A resume check score at or above this reads as "in good shape". */
export const STRONG_SCORE = 80;

export interface DashboardFacts {
  /** Null while the resume list is loading. */
  hasResume: boolean | null;
  /** The primary base resume (or the first base one), when there is one. */
  primaryResumeId: string | null;
  /** The latest finished check's score, 0–100; null when none finished. */
  resumeScore: number | null;
  tailoredCount: number | null;
  letterCount: number | null;
  /** Profile completeness, 0–100. */
  profileCompleteness: number | null;
  /** Tracker entries per status (bookmarked, applied, first_call, …). */
  statusCounts: Readonly<Record<string, number>> | null;
  /** Applications being prepared or waiting for review (the Ready to apply queue). */
  preparingCount: number | null;
  /** Finished practice interviews. */
  practiceCompleted: number | null;
}

export const EMPTY_FACTS: DashboardFacts = {
  hasResume: null,
  primaryResumeId: null,
  resumeScore: null,
  tailoredCount: null,
  letterCount: null,
  profileCompleteness: null,
  statusCounts: null,
  preparingCount: null,
  practiceCompleted: null,
};

export interface StepProgress {
  id: StepId;
  kind: 'percent' | 'count';
  /** Percentage or count; null when the fact is not known. */
  value: number | null;
  /** The count goal (count steps only). */
  target: number | null;
  /** 0–1, how full the bar is. 0 when the value is unknown. */
  fraction: number;
  /** The step has begun (a score exists, or the count is above zero). */
  started: boolean;
  done: boolean;
}

const clampPct = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

function sumStatuses(counts: Readonly<Record<string, number>> | null, statuses: readonly string[]): number | null {
  if (!counts) return null;
  return statuses.reduce((acc, s) => acc + (Number.isFinite(counts[s]) ? Math.max(0, counts[s] ?? 0) : 0), 0);
}

// Tracker statuses, as server/src/features/tracker/contract.ts defines them
// (TRACKER_STATUSES + LEGACY_TRACKER_STATUSES; the web mirror is type-only,
// so the lists are repeated here and pinned by model.test.ts).
/** A saved job (`saved` is an older spelling some rows still carry). */
export const SAVED_STATUSES = ['bookmarked', 'saved'] as const;
/** A conversation with the employer is happening (the contract's INTERVIEW_STATUSES). */
export const INTERVIEW_STAGES = ['first_call', 'assessment', 'written_test', 'ai_interview', 'interviewing', 'final_round'] as const;
/** An offer, made or taken (the contract's OFFER_STATUSES). */
export const OFFER_STAGES = ['offer', 'signed', 'negotiating', 'accepted'] as const;
/** The application went out: applied (or the legacy `applying`), anything after it, or a "no" from the employer. Withdrawn and closed are not counted (they can happen before applying). */
export const APPLIED_STATUSES = ['applying', 'applied', ...INTERVIEW_STAGES, ...OFFER_STAGES, 'rejected'] as const;
/** Reached an interview: every interview stage and every offer stage. */
export const INTERVIEW_STATUSES = [...INTERVIEW_STAGES, ...OFFER_STAGES] as const;

function percentStep(id: StepId, value: number | null, doneAt: number): StepProgress {
  const v = value === null ? null : clampPct(value);
  return {
    id,
    kind: 'percent',
    value: v,
    target: null,
    fraction: v === null ? 0 : v / 100,
    started: v !== null && v > 0,
    done: v !== null && v >= doneAt,
  };
}

function countStep(id: keyof typeof STEP_TARGETS, value: number | null): StepProgress {
  const target = STEP_TARGETS[id];
  const v = value === null ? null : Math.max(0, Math.floor(value));
  return {
    id,
    kind: 'count',
    value: v,
    target,
    fraction: v === null ? 0 : Math.min(1, v / target),
    started: v !== null && v > 0,
    done: v !== null && v >= target,
  };
}

export function stepProgress(id: StepId, facts: DashboardFacts): StepProgress {
  switch (id) {
    case 'resume_check':
      // No resume yet reads as 0%; a resume without a finished check is unknown.
      if (facts.hasResume === false) return percentStep(id, 0, STRONG_SCORE);
      return percentStep(id, facts.resumeScore, STRONG_SCORE);
    case 'tailored':
      return countStep(id, facts.tailoredCount);
    case 'letters':
      return countStep(id, facts.letterCount);
    case 'profile':
      return percentStep(id, facts.profileCompleteness, 100);
    case 'saved':
      return countStep(id, sumStatuses(facts.statusCounts, SAVED_STATUSES));
    case 'preparing':
      return countStep(id, facts.preparingCount);
    case 'applied':
      return countStep(id, sumStatuses(facts.statusCounts, APPLIED_STATUSES));
    case 'interviews':
      return countStep(id, sumStatuses(facts.statusCounts, INTERVIEW_STATUSES));
    case 'practice':
      return countStep(id, facts.practiceCompleted);
  }
}

/** Steps whose area is switched off for this user (e.g. `preparing` without the `agent` capability). */
export type HiddenSteps = ReadonlySet<StepId>;
const NONE_HIDDEN: HiddenSteps = new Set();

export function goalSteps(goal: GoalId, facts: DashboardFacts, hidden: HiddenSteps = NONE_HIDDEN): StepProgress[] {
  return GOAL_STEPS[goal].filter((id) => !hidden.has(id)).map((id) => stepProgress(id, facts));
}

export function isGoal(value: unknown): value is GoalId {
  return typeof value === 'string' && (GOALS as readonly string[]).includes(value);
}

export function isStepOf(goal: GoalId, value: unknown, hidden: HiddenSteps = NONE_HIDDEN): value is StepId {
  return typeof value === 'string' && (GOAL_STEPS[goal] as readonly string[]).includes(value) && !hidden.has(value as StepId);
}

/** The goal a step belongs to. */
export function goalOf(step: StepId): GoalId {
  return GOALS.find((g) => (GOAL_STEPS[g] as readonly string[]).includes(step)) ?? 'resume';
}

/**
 * The step to open when none is chosen: the first one in the goal that is
 * not done yet, else the first. Unknown values count as "not done", so a
 * still-loading goal opens on its first step and does not jump later.
 */
export function defaultStep(goal: GoalId, facts: DashboardFacts, hidden: HiddenSteps = NONE_HIDDEN): StepId {
  const steps = goalSteps(goal, facts, hidden);
  return (steps.find((s) => !s.done) ?? steps[0]!).id;
}

/** Read `?goal=` and `?step=`; anything else falls back to the defaults. */
export function selectionFrom(
  params: { goal: string | null; step: string | null },
  facts: DashboardFacts,
  hidden: HiddenSteps = NONE_HIDDEN,
): { goal: GoalId; step: StepId; explicitStep: boolean } {
  const goal = isGoal(params.goal) ? params.goal : 'resume';
  if (isStepOf(goal, params.step, hidden)) return { goal, step: params.step, explicitStep: true };
  return { goal, step: defaultStep(goal, facts, hidden), explicitStep: false };
}

/** Where each step's call to action goes. */
export function stepHref(step: StepId, facts: Pick<DashboardFacts, 'primaryResumeId' | 'hasResume'>): string {
  switch (step) {
    case 'resume_check':
      return facts.primaryResumeId ? `/resume/${encodeURIComponent(facts.primaryResumeId)}` : '/resume';
    case 'tailored':
      return '/resume';
    case 'letters':
      return '/resume/letters';
    case 'profile':
      return '/profile';
    case 'saved':
      return '/jobs';
    case 'preparing':
      return '/ready';
    case 'applied':
    case 'interviews':
      return '/applications';
    case 'practice':
      return '/practice';
  }
}

/**
 * Which copy the hero uses: `start` until the step has begun, `more` after.
 * The resume check has a third state, `no_resume`, for a user without one.
 */
export function heroState(progress: StepProgress, facts: Pick<DashboardFacts, 'hasResume'>): 'no_resume' | 'start' | 'more' {
  if (progress.id === 'resume_check' && facts.hasResume === false) return 'no_resume';
  return progress.started ? 'more' : 'start';
}
