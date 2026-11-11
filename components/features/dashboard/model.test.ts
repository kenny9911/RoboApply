import { describe, expect, it } from 'vitest';

import {
  ALL_STEPS,
  APPLIED_STATUSES,
  INTERVIEW_STATUSES,
  SAVED_STATUSES,
  EMPTY_FACTS,
  GOALS,
  GOAL_STEPS,
  STEP_TARGETS,
  defaultStep,
  goalOf,
  goalSteps,
  heroState,
  selectionFrom,
  stepHref,
  stepProgress,
  type DashboardFacts,
  type StepId,
} from './model';

const facts = (over: Partial<DashboardFacts> = {}): DashboardFacts => ({ ...EMPTY_FACTS, ...over });

describe('dashboard model: goals and steps', () => {
  it('has the four resume.io-style goals, each with at least one step, and every step in exactly one goal', () => {
    expect(GOALS).toEqual(['resume', 'jobs', 'applications', 'interview']);
    for (const g of GOALS) expect(GOAL_STEPS[g].length).toBeGreaterThan(0);
    expect(new Set(ALL_STEPS).size).toBe(ALL_STEPS.length);
    for (const s of ALL_STEPS) expect(GOAL_STEPS[goalOf(s)]).toContain(s);
  });

  it('every count step has a positive target', () => {
    for (const [, target] of Object.entries(STEP_TARGETS)) expect(target).toBeGreaterThan(0);
  });
});

describe('dashboard model: progress never invents a number', () => {
  it('an unknown fact is null with an empty bar, not zero', () => {
    for (const id of ALL_STEPS) {
      const p = stepProgress(id, EMPTY_FACTS);
      expect(p.value, id).toBeNull();
      expect(p.fraction, id).toBe(0);
      expect(p.started, id).toBe(false);
      expect(p.done, id).toBe(false);
    }
  });

  it('a user without a resume reads 0% on the resume check (a known zero)', () => {
    const p = stepProgress('resume_check', facts({ hasResume: false }));
    expect(p).toMatchObject({ kind: 'percent', value: 0, fraction: 0, done: false });
  });

  it('a resume without a finished check stays unknown', () => {
    expect(stepProgress('resume_check', facts({ hasResume: true, resumeScore: null })).value).toBeNull();
  });

  it('percent steps clamp and round the server value; the check is done at the strong score', () => {
    expect(stepProgress('resume_check', facts({ hasResume: true, resumeScore: 79.6 }))).toMatchObject({ value: 80, done: true });
    expect(stepProgress('resume_check', facts({ hasResume: true, resumeScore: 64 }))).toMatchObject({ value: 64, fraction: 0.64, done: false });
    expect(stepProgress('profile', facts({ profileCompleteness: 140 }))).toMatchObject({ value: 100, fraction: 1, done: true });
    expect(stepProgress('profile', facts({ profileCompleteness: -3 }))).toMatchObject({ value: 0, started: false });
  });

  it('count steps fill toward their stated target and never past it', () => {
    expect(stepProgress('tailored', facts({ tailoredCount: 1 }))).toMatchObject({ kind: 'count', value: 1, target: 3, started: true, done: false });
    expect(stepProgress('tailored', facts({ tailoredCount: 1 })).fraction).toBeCloseTo(1 / 3);
    expect(stepProgress('tailored', facts({ tailoredCount: 9 }))).toMatchObject({ value: 9, fraction: 1, done: true });
    expect(stepProgress('letters', facts({ letterCount: 0 }))).toMatchObject({ value: 0, started: false, done: false });
  });

  it('tracker counts: saved, applied (at or past applied, or a no), interviews (interview and offer stages)', () => {
    const statusCounts = {
      bookmarked: 2, saved: 1, applying: 1, applied: 3, first_call: 1, assessment: 1, written_test: 0, ai_interview: 1,
      interviewing: 1, final_round: 1, offer: 1, signed: 0, negotiating: 1, accepted: 0, rejected: 2, withdrawn: 4, closed: 5,
    };
    const f = facts({ statusCounts });
    expect(stepProgress('saved', f).value).toBe(3);
    expect(stepProgress('applied', f).value).toBe(1 + 3 + (1 + 1 + 0 + 1 + 1 + 1) + (1 + 0 + 1 + 0) + 2);
    expect(stepProgress('interviews', f).value).toBe(1 + 1 + 0 + 1 + 1 + 1 + 1 + 0 + 1 + 0);
  });

  it('getting ready counts the Ready to apply queue, not a tracker status', () => {
    expect(stepProgress('preparing', facts({ statusCounts: { applying: 7 } })).value).toBeNull();
    expect(stepProgress('preparing', facts({ preparingCount: 2 }))).toMatchObject({ value: 2, target: 3, started: true });
  });

  it('the status lists cover every tracker status the server defines, except the two that can come before applying', () => {
    const server = ['bookmarked', 'applied', 'first_call', 'assessment', 'written_test', 'ai_interview', 'interviewing', 'final_round', 'offer', 'signed', 'rejected', 'withdrawn', 'closed', 'applying', 'negotiating', 'accepted'];
    const counted = new Set<string>([...SAVED_STATUSES, ...APPLIED_STATUSES]);
    expect(server.filter((s) => !counted.has(s))).toEqual(['withdrawn', 'closed']);
    for (const s of INTERVIEW_STATUSES) expect(APPLIED_STATUSES as readonly string[]).toContain(s);
  });

  it('ignores negative or missing tracker counts', () => {
    const f = facts({ statusCounts: { bookmarked: -4 } });
    expect(stepProgress('saved', f).value).toBe(0);
    expect(stepProgress('applied', f).value).toBe(0);
  });
});

describe('dashboard model: selection', () => {
  it('opens on the first step of the goal that is not done', () => {
    const f = facts({ hasResume: true, resumeScore: 92, tailoredCount: 0, letterCount: 2 });
    expect(defaultStep('resume', f)).toBe('tailored');
    expect(defaultStep('resume', facts({ hasResume: true, resumeScore: 92, tailoredCount: 5, letterCount: 2 }))).toBe('resume_check');
  });

  it('reads ?goal= and ?step=, and falls back for anything it does not know', () => {
    expect(selectionFrom({ goal: 'jobs', step: 'saved' }, EMPTY_FACTS)).toEqual({ goal: 'jobs', step: 'saved', explicitStep: true });
    expect(selectionFrom({ goal: 'jobs', step: 'tailored' }, EMPTY_FACTS)).toMatchObject({ goal: 'jobs', step: 'profile', explicitStep: false });
    expect(selectionFrom({ goal: 'nope', step: null }, EMPTY_FACTS)).toMatchObject({ goal: 'resume', step: 'resume_check' });
  });

  it('a hidden step is never listed or selected', () => {
    const hidden = new Set<StepId>(['preparing']);
    expect(goalSteps('applications', EMPTY_FACTS, hidden).map((s) => s.id)).toEqual(['applied', 'interviews']);
    expect(selectionFrom({ goal: 'applications', step: 'preparing' }, EMPTY_FACTS, hidden)).toMatchObject({ step: 'applied', explicitStep: false });
  });
});

describe('dashboard model: where each step leads', () => {
  it('links every step to a signed-in page', () => {
    for (const id of ALL_STEPS) expect(stepHref(id, facts()).startsWith('/'), id).toBe(true);
  });

  it('the resume check opens the primary resume when there is one, the hub otherwise', () => {
    expect(stepHref('resume_check', facts({ primaryResumeId: 'cm 1' }))).toBe('/resume/cm%201');
    expect(stepHref('resume_check', facts())).toBe('/resume');
  });

  it('hero copy: no resume, then start until the step has begun, then more', () => {
    expect(heroState(stepProgress('resume_check', facts({ hasResume: false })), { hasResume: false })).toBe('no_resume');
    expect(heroState(stepProgress('tailored', facts({ tailoredCount: 0 })), { hasResume: true })).toBe('start');
    expect(heroState(stepProgress('tailored', facts({ tailoredCount: 2 })), { hasResume: true })).toBe('more');
  });
});
