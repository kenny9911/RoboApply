// Who gets the two-screen start (/onboarding/start) and who keeps the long
// screens; and the order in which the start flow saves the server's steps,
// checked against the server's own stage machine (pure functions, no I/O).

import { describe, expect, it } from 'vitest';

import { StageError, afterSave, assertStepSavable, branchForTiming, effectiveStage, screenStages, type StageRecord } from '../../../server/src/features/onboarding/stageMachine';
import type { OnboardingStage } from '../../../server/src/features/onboarding/contract';
import {
  CLASSIC_FLOW_ROUTE,
  EXPRESS_START_ROUTE,
  ONBOARDING_SCREEN_STAGES,
  classicFlowChosen,
  expressLanding,
  expressRedirect,
  expressSavePlan,
  expressStartExit,
  onboardingIndexTarget,
  startsInExpress,
} from './flow';
import { TIMINGS } from './options';

type State = Parameters<typeof onboardingIndexTarget>[0];
const ra = (over: Partial<State> = {}): State => ({ brand: 'roboapply', stage: 'situation', completed: false, nextRoute: '/onboarding/situation', firstValueRoute: '/jobs', ...over });
const ga = (over: Partial<State> = {}): State => ({ brand: 'goapply', stage: 'consent', completed: false, nextRoute: '/onboarding/consent', firstValueRoute: '/campus', ...over });

const fresh = ra();
const midWay = ra({ stage: 'basics', nextRoute: '/onboarding/basics' });
const atResume = ra({ stage: 'resume', nextRoute: '/onboarding/resume' });
const atTour = ra({ stage: 'tour', nextRoute: '/jobs' });
const finished = ra({ stage: 'done', completed: true, nextRoute: null });
const cnFresh = ga();
const cnMidWay = ga({ stage: 'intent', nextRoute: '/onboarding/intent' });
const cnTour = ga({ stage: 'tour', nextRoute: '/campus' });
const cnFinished = ga({ stage: 'done', completed: true, nextRoute: null });
const EVERY = [fresh, midWay, atResume, atTour, finished, cnFresh, cnMidWay, cnTour, cnFinished];

describe('who starts in the two-screen flow', () => {
  it('a RoboApply user who has saved no step; nobody else', () => {
    expect(startsInExpress(fresh)).toBe(true);
    for (const s of [midWay, atResume, atTour, finished, cnFresh, cnMidWay, cnTour, cnFinished]) expect(startsInExpress(s)).toBe(false);
  });

  it('/onboarding sends a new RoboApply user to the start; everyone else goes where they went before', () => {
    expect(onboardingIndexTarget(fresh)).toBe('/onboarding/start');
    expect(onboardingIndexTarget(midWay)).toBe('/onboarding/basics');
    expect(onboardingIndexTarget(atResume)).toBe('/onboarding/resume');
    expect(onboardingIndexTarget(atTour)).toBe('/jobs');
    expect(onboardingIndexTarget(finished)).toBe('/jobs');
    expect(onboardingIndexTarget(cnFresh)).toBe('/onboarding/consent');
    expect(onboardingIndexTarget(cnMidWay)).toBe('/onboarding/intent');
    expect(onboardingIndexTarget(cnTour)).toBe('/onboarding/confirm');
    expect(onboardingIndexTarget(cnFinished)).toBe('/campus');
  });

  it('a long screen sends a new RoboApply user to the start, unless they chose the long screens', () => {
    expect(expressRedirect(fresh, false)).toBe('/onboarding/start');
    expect(expressRedirect(fresh, true)).toBeNull();
    for (const s of [midWay, atResume, atTour, finished, cnFresh, cnMidWay, cnTour, cnFinished]) {
      expect(expressRedirect(s, false)).toBeNull();
      expect(expressRedirect(s, true)).toBeNull();
    }
  });

  it('the choice of the long screens is the `classic=1` query flag, and the link carries it', () => {
    expect(CLASSIC_FLOW_ROUTE).toBe('/onboarding/situation?classic=1');
    expect(classicFlowChosen(new URLSearchParams('classic=1'))).toBe(true);
    expect(classicFlowChosen(new URLSearchParams(new URL(CLASSIC_FLOW_ROUTE, 'http://x').search))).toBe(true);
    expect(classicFlowChosen(new URLSearchParams(''))).toBe(false);
    expect(classicFlowChosen(new URLSearchParams('classic=0'))).toBe(false);
    expect(classicFlowChosen(null)).toBe(false);
  });

  it('/onboarding/start shows for a new user, sends a finished one to Today and anyone else to their own screen', () => {
    expect(expressStartExit(fresh)).toBeNull();
    expect(expressStartExit(finished)).toBe('/today');
    expect(expressStartExit(midWay)).toBe('/onboarding/basics');
    expect(expressStartExit(atResume)).toBe('/onboarding/resume');
    expect(expressStartExit(atTour)).toBe('/jobs');
    // GoApply never has this screen (the route is a 404 there); if it is reached anyway, its own flow takes over.
    expect(expressStartExit(cnFresh)).toBe('/onboarding/consent');
    expect(expressStartExit(cnTour)).toBe('/onboarding/confirm');
    expect(expressStartExit(cnFinished)).toBe('/campus');
  });

  it('never loops: nobody is sent to the start from a screen the start sends them to, or back', () => {
    for (const s of EVERY) {
      for (const classic of [false, true]) {
        // Sent to the start → the start shows.
        if (expressRedirect(s, classic) === EXPRESS_START_ROUTE) expect(expressStartExit(s)).toBeNull();
      }
      // Sent away from the start → not to itself, and the long screen there does not send them back.
      const exit = expressStartExit(s);
      expect(exit).not.toBe(EXPRESS_START_ROUTE);
      if (exit?.startsWith('/onboarding/')) expect(expressRedirect(s, false)).toBeNull();
      // /onboarding names the start only for a user the start shows for.
      if (onboardingIndexTarget(s) === EXPRESS_START_ROUTE) expect(expressStartExit(s)).toBeNull();
    }
  });

  it('the start is a web screen, not a server stage', () => {
    expect(ONBOARDING_SCREEN_STAGES.roboapply).not.toContain('start');
    expect(ONBOARDING_SCREEN_STAGES.goapply).not.toContain('start');
  });
});

describe('where the start flow lands', () => {
  it('Today; the job a user signed up for when the server names it', () => {
    expect(expressLanding(null)).toBe('/today');
    expect(expressLanding(undefined)).toBe('/today');
    // The server's plain answer for RoboApply (the job list) is replaced by Today.
    expect(expressLanding('/jobs')).toBe('/today');
    expect(expressLanding('/jobs/cm_job_1')).toBe('/jobs/cm_job_1');
    expect(expressLanding('/campus')).toBe('/today');
  });
});

describe('the order the start flow saves in', () => {
  it('is the stage machine\'s order for the branch the timing chooses, then `complete`', () => {
    expect(expressSavePlan('asap')).toEqual(['situation', 'basics', 'resume', 'matching', 'confirm', 'complete']);
    expect(expressSavePlan('next_few_months')).toEqual(['situation', 'basics', 'goal', 'preferences', 'resume', 'matching', 'confirm', 'complete']);
    for (const timing of TIMINGS) {
      expect(expressSavePlan(timing)).toEqual([...screenStages('roboapply', branchForTiming(timing)), 'complete']);
    }
  });

  /** One plan entry under the server's rules. Throws StageError where the server would refuse the save. */
  function apply(rec: StageRecord, name: string, timing: string): StageRecord {
    if (name === 'complete') {
      // POST /complete: only once confirm is saved.
      expect(effectiveStage('roboapply', rec)).toBe('tour');
      return { ...rec, step: 'done', completedAt: new Date() };
    }
    if (name === 'matching') {
      // POST /match is allowed at matching, confirm and tour; a finished (or backgrounded) run moves `matching` on.
      expect(['matching', 'confirm', 'tour']).toContain(effectiveStage('roboapply', rec));
      return effectiveStage('roboapply', rec) === 'matching' ? { ...rec, step: 'confirm' } : rec;
    }
    const step = name as OnboardingStage;
    const branchAfter = step === 'situation' ? branchForTiming(timing) : (rec.path as ReturnType<typeof branchForTiming> | null);
    assertStepSavable('roboapply', rec, step, { skip: step === 'goal' || step === 'preferences', branchAfter });
    const t = afterSave('roboapply', rec, step, branchAfter);
    return { ...rec, step: t.step, path: t.path };
  }
  /** A new account is stored at `account`. */
  const newAccount = (): StageRecord => ({ step: 'account', path: null, answers: {} });
  const walk = (plan: string[], timing: string, from: StageRecord = newAccount()): StageRecord => plan.reduce((rec, name) => apply(rec, name, timing), from);

  it.each(TIMINGS)('the server accepts every step of the plan in that order (timing %s)', (timing) => {
    expect(walk(expressSavePlan(timing), timing).step).toBe('done');
  });

  it('the two skipped steps are needed: without them the explore branch refuses `resume`', () => {
    const short = expressSavePlan('just_looking').filter((s) => s !== 'goal' && s !== 'preferences');
    expect(() => walk(short, 'just_looking')).toThrow(StageError);
  });

  it('a retry is accepted wherever the first try stopped: saving the earlier steps again never moves the stage back', () => {
    for (const timing of TIMINGS) {
      const plan = expressSavePlan(timing).slice(0, -1);
      for (let stopped = 1; stopped <= plan.length; stopped++) {
        const done = plan.slice(0, stopped);
        const before = walk(done, timing);
        const after = walk(done, timing, before);
        expect(effectiveStage('roboapply', after)).toBe(effectiveStage('roboapply', before));
      }
    }
  });

  it('a retry with another timing changes the branch and is still accepted', () => {
    // First try: explore, stopped after the skipped steps. Second try: as soon as possible (no goal, no preferences).
    const first = walk(['situation', 'basics', 'goal', 'preferences'], 'just_looking');
    expect(walk(expressSavePlan('asap'), 'asap', first).step).toBe('done');
    // And the other way round: urgent up to the resume, then explore.
    const urgent = walk(['situation', 'basics', 'resume'], 'asap');
    expect(walk(expressSavePlan('next_few_months'), 'next_few_months', urgent).step).toBe('done');
  });
});
