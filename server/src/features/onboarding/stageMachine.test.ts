// @vitest-environment node
//
// WP-30: the onboarding stage machine as table tests (both branches, both
// brands, skip rules, Back + re-submit, leaving early, the `account` rule).

import { describe, expect, it } from 'vitest';
import {
  StageError,
  afterSave,
  assertStepSavable,
  branchForTiming,
  effectiveStage,
  isPaused,
  meOf,
  progressOf,
  routeFor,
  screenStages,
  type StageRecord,
} from './stageMachine.js';

const rec = (over: Partial<StageRecord> = {}): StageRecord => ({ step: 'account', path: null, answers: {}, ...over });

describe('screens per brand and branch', () => {
  it.each([
    ['roboapply', 'urgent', ['situation', 'basics', 'resume', 'matching', 'confirm']],
    ['roboapply', 'explore', ['situation', 'basics', 'goal', 'preferences', 'resume', 'matching', 'confirm']],
    ['roboapply', null, ['situation', 'basics', 'resume', 'matching', 'confirm']],
    ['goapply', null, ['consent', 'identity', 'education', 'intent', 'tags', 'resume', 'matching', 'confirm']],
  ] as const)('%s / %s', (brand, branch, screens) => {
    expect(screenStages(brand, branch)).toEqual(screens);
  });

  it('timing "As soon as possible" is the urgent branch, the other two explore', () => {
    expect(branchForTiming('asap')).toBe('urgent');
    expect(branchForTiming('next_few_months')).toBe('explore');
    expect(branchForTiming('just_looking')).toBe('explore');
  });
});

describe('effective stage', () => {
  it.each([
    ['fresh RoboApply account → situation', 'roboapply', rec(), 'situation'],
    ['fresh GoApply account → consent', 'goapply', rec(), 'consent'],
    ['goal on urgent is hidden → resume', 'roboapply', rec({ step: 'goal', path: 'urgent' }), 'resume'],
    ['goal on explore stays', 'roboapply', rec({ step: 'goal', path: 'explore' }), 'goal'],
    ['unknown code reads as done', 'roboapply', rec({ step: 'mode' }), 'done'],
    ['GoApply code on RoboApply reads as done', 'roboapply', rec({ step: 'consent' }), 'done'],
    ['left early → the left-at stage', 'roboapply', rec({ step: 'done', answers: { leftEarly: { at: 't', stage: 'basics' } } }), 'basics'],
    ['finished → done even with an old leftEarly', 'roboapply', rec({ step: 'done', completedAt: new Date(), answers: { leftEarly: { at: 't', stage: 'basics' } } }), 'done'],
  ] as const)('%s', (_name, brand, r, expected) => {
    expect(effectiveStage(brand, r)).toBe(expected);
  });
});

describe('saving a step', () => {
  it('moves forward along the urgent branch', () => {
    let r = rec();
    const order: Array<[string, string]> = [];
    for (const step of ['situation', 'basics', 'resume', 'confirm'] as const) {
      const branch = 'urgent';
      assertStepSavable('roboapply', r, step, { branchAfter: branch });
      const t = afterSave('roboapply', r, step, branch);
      order.push([step, t.step]);
      r = { ...r, step: t.step, path: t.path };
      if (step === 'resume') r = { ...r, step: 'confirm' }; // the match run moves matching → confirm
    }
    expect(order).toEqual([
      ['situation', 'basics'],
      ['basics', 'resume'],
      ['resume', 'matching'],
      ['confirm', 'tour'],
    ]);
  });

  it('visits goal and preferences on explore', () => {
    const r = rec({ step: 'basics', path: 'explore' });
    expect(afterSave('roboapply', r, 'basics', 'explore')).toMatchObject({ step: 'goal', nextStage: 'goal' });
    expect(afterSave('roboapply', rec({ step: 'goal', path: 'explore' }), 'goal', 'explore')).toMatchObject({ step: 'preferences' });
    expect(afterSave('roboapply', rec({ step: 'preferences', path: 'explore' }), 'preferences', 'explore')).toMatchObject({ step: 'resume' });
  });

  it('Back + re-submit never moves the stored stage backwards', () => {
    const r = rec({ step: 'resume', path: 'urgent' });
    const t = afterSave('roboapply', r, 'situation', 'urgent');
    expect(t).toMatchObject({ step: 'resume', nextStage: 'basics' });
  });

  it('switching urgent → explore from situation sends the next screen through goal', () => {
    const r = rec({ step: 'resume', path: 'urgent' });
    const t = afterSave('roboapply', r, 'situation', 'explore');
    expect(t.nextStage).toBe('basics');
    expect(t.path).toBe('explore');
    // basics → goal now, even though the stored stage is further on.
    expect(afterSave('roboapply', { ...r, path: 'explore' }, 'basics', 'explore').nextStage).toBe('goal');
  });

  it('switching explore → urgent while at goal moves the stored stage past the hidden steps', () => {
    const r = rec({ step: 'goal', path: 'explore' });
    expect(afterSave('roboapply', r, 'situation', 'urgent').step).toBe('resume');
  });

  it.each([
    ['situation cannot be skipped', 'roboapply', rec(), 'situation', { skip: true }, 'onboarding_step_required'],
    ['identity cannot be skipped', 'goapply', rec({ step: 'identity' }), 'identity', { skip: true }, 'onboarding_step_required'],
    ['no jumping ahead', 'roboapply', rec(), 'resume', {}, 'onboarding_step_not_available'],
    ['goal is not on urgent', 'roboapply', rec({ step: 'resume', path: 'urgent' }), 'goal', {}, 'onboarding_step_not_available'],
    ['matching takes no answers', 'roboapply', rec({ step: 'matching', path: 'urgent' }), 'matching', {}, 'onboarding_step_not_available'],
    ['tour takes no answers', 'roboapply', rec({ step: 'tour' }), 'tour', {}, 'onboarding_step_not_available'],
    ['GoApply has no basics', 'goapply', rec({ step: 'resume' }), 'basics', {}, 'onboarding_step_not_available'],
  ] as const)('%s', (_n, brand, r, step, opts, reason) => {
    try {
      assertStepSavable(brand, r, step as never, opts);
      throw new Error('expected a StageError');
    } catch (err) {
      expect(err).toBeInstanceOf(StageError);
      expect((err as StageError).reason).toBe(reason);
    }
  });

  it('every step after the account step except situation/identity/consent may be skipped', () => {
    expect(() => assertStepSavable('roboapply', rec({ step: 'basics', path: 'urgent' }), 'basics', { skip: true })).not.toThrow();
    expect(() => assertStepSavable('goapply', rec({ step: 'tags' }), 'tags', { skip: true })).not.toThrow();
  });

  it('finished users can re-save answers without reopening onboarding', () => {
    const r = rec({ step: 'done', path: 'urgent', completedAt: new Date() });
    expect(() => assertStepSavable('roboapply', r, 'confirm', {})).not.toThrow();
    expect(afterSave('roboapply', r, 'basics', 'urgent').step).toBe('done');
  });
});

describe('leaving early', () => {
  const left = rec({ step: 'done', path: 'urgent', answers: { leftEarly: { at: '2026-10-10T00:00:00Z', stage: 'basics' } } });

  it('is paused, counts the steps left and shows a done /auth/me (no forced routing)', () => {
    expect(isPaused('roboapply', left)).toBe(true);
    expect(progressOf('roboapply', left)).toEqual({ total: 5, stepsLeft: 4, leftEarly: { at: '2026-10-10T00:00:00Z', stage: 'basics' } });
    expect(meOf('roboapply', left)).toEqual({ step: 'done', path: 'urgent', completed: true, nextRoute: null });
  });

  it('saving a step resumes from the left-at stage', () => {
    const t = afterSave('roboapply', left, 'basics', 'urgent');
    expect(t).toMatchObject({ step: 'resume', resumed: true });
  });
});

describe('/auth/me.onboarding and routes', () => {
  it('account points at the first screen (WP-10 carry-over rule)', () => {
    expect(meOf('roboapply', rec())).toEqual({ step: 'account', path: null, completed: false, nextRoute: '/onboarding/situation' });
    expect(meOf('goapply', rec())).toEqual({ step: 'account', path: null, completed: false, nextRoute: '/onboarding/consent' });
  });

  it('tour lands on /jobs, or on the carried job', () => {
    expect(routeFor('roboapply', 'tour', null)).toBe('/jobs');
    expect(routeFor('roboapply', 'tour', { jobId: 'cjob1' })).toBe('/jobs/cjob1');
    expect(routeFor('roboapply', 'basics', { jobId: 'cjob1' })).toBe('/onboarding/basics');
  });

  it('progress is 0 once in the tour or done', () => {
    expect(progressOf('roboapply', rec({ step: 'tour' })).stepsLeft).toBe(0);
    expect(progressOf('roboapply', rec({ step: 'confirm', path: 'explore' }))).toMatchObject({ total: 7, stepsLeft: 1 });
  });
});
