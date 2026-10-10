// WP-30: the web copies of the onboarding enumerations stay equal to the
// server contract (the web bundle never imports server runtime code).

import { describe, expect, it } from 'vitest';

import * as C from '../../../server/src/features/onboarding/contract';
import { ONBOARDING_SCREEN_STAGES, STAGE_ORDER, screensFor } from './flow';
import * as O from './options';

describe('options mirror the server contract', () => {
  it.each([
    ['timings', O.TIMINGS, C.ONBOARDING_TIMINGS],
    ['seeker types', O.SEEKER_TYPES, C.SEEKER_TYPES],
    ['job types', O.JOB_TYPES, C.ONBOARDING_JOB_TYPES],
    ['sponsorship', O.SPONSORSHIP_ANSWERS, C.SPONSORSHIP_ANSWERS],
    ['countries', O.MVP_COUNTRIES, C.ONBOARDING_MVP_COUNTRIES],
    ['goals', O.CAREER_GOALS, C.CAREER_GOALS],
    ['company sizes', O.COMPANY_SIZES, C.ONBOARDING_COMPANY_SIZES],
    ['work models', O.WORK_MODELS, C.ONBOARDING_WORK_MODELS],
    ['levels', O.EXPERIENCE_LEVELS, C.ONBOARDING_EXPERIENCE_LEVELS],
    ['alerts', O.ALERT_FREQUENCIES, C.ALERT_FREQUENCIES],
    ['heard from', O.HEARD_FROM, C.HEARD_FROM_OPTIONS],
    ['phases', O.MATCH_PHASES, C.ONBOARDING_MATCH_PHASES],
  ])('%s', (_n, web, server) => {
    expect([...web]).toEqual([...server]);
  });

  it('industries, limits and UI keys', () => {
    expect(O.INDUSTRIES).toEqual(C.ONBOARDING_INDUSTRIES);
    expect(O.UI_KEYS).toEqual(C.ONBOARDING_UI_KEYS);
    expect(O.FINISH_BANNER_MAX_DISMISSALS).toBe(C.FINISH_BANNER_MAX_DISMISSALS);
    expect(O.LIMITS.pasteMinChars).toBe(C.ONBOARDING_PASTE_MIN_CHARS);
    expect(O.LIMITS.resumeMaxBytes).toBe(C.ONBOARDING_RESUME_MAX_BYTES);
    // The LinkedIn rule is the contract's.
    for (const url of ['https://www.linkedin.com/in/sample', 'https://linkedin.com/in/sample/', 'https://example.com/in/x', 'http://www.linkedin.com/in/x']) {
      expect(O.LINKEDIN_URL_RE.test(url)).toBe(C.ConfirmStepSchema.shape.linkedinUrl.safeParse(url).success);
    }
  });
});

describe('screen order mirrors the stage machine', () => {
  it('stage order and screens per brand', () => {
    expect(STAGE_ORDER).toEqual(C.ONBOARDING_STAGE_ORDER);
    for (const brand of ['roboapply', 'goapply'] as const) {
      const routed = Object.entries(C.ONBOARDING_STAGE_ROUTES[brand])
        .filter(([, r]) => r?.startsWith('/onboarding/'))
        .map(([s]) => s);
      expect([...ONBOARDING_SCREEN_STAGES[brand]]).toEqual(routed);
    }
    expect(screensFor('roboapply', 'urgent')).toEqual(['situation', 'basics', 'resume', 'matching', 'confirm']);
    expect(screensFor('roboapply', 'explore')).toEqual(['situation', 'basics', 'goal', 'preferences', 'resume', 'matching', 'confirm']);
    expect(screensFor('goapply', null)).toEqual(ONBOARDING_SCREEN_STAGES.goapply);
  });
});
