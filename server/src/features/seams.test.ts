// @vitest-environment node
//
// FND-5 seams: the onboarding stage machine contract (R-06), the market hook
// registry, the delivery-channel extension point, the service interfaces
// every area exposes (shape only — whether a method is still a stub is not
// asserted here, so an owner filling its index.ts never edits this shared
// file) and contract invariants that encode product rules (D1, PIPL, honesty).

import { describe, expect, it, vi } from 'vitest';
import * as onboarding from './onboarding/index.js';
import * as onboardingCn from './onboarding-cn/index.js';
import { MARKET_HOOK_SETS, afterEnrich, afterNormalize, cardMeta, type MarketHookSet } from './jobs/marketHooks.js';
import { deliveryChannels, registerDeliveryChannel, resetDeliveryChannelsForTests, type DeliveryChannel } from './alerts/index.js';
import { authFeatureService } from './auth/index.js';
import { authCnService, CN_MOBILE_RE } from './auth-cn/index.js';
import { complianceService } from './compliance/index.js';
import { profileService } from './profile/index.js';
import { feedService } from './feed/index.js';
import { jobImportService, ImportJobBodySchema } from './jobs/import/index.js';
import { jobDetailService } from './jobs/detail/index.js';
import { companyService } from './jobs/companies/index.js';
import { matchService, tierForScore } from './match/index.js';
import { copilotService, handleVisitorTurn, listFeedback, CARD_TYPES } from './copilot/index.js';
import { resumeSuiteService, UpdateClaimBodySchema } from './resume/index.js';
import { coverLetterService } from './coverletter/index.js';
import { trackerService, updateOffer } from './tracker/index.js';
import { offersService } from './offers/index.js';
import { networkService } from './network/index.js';
import { agentService, QUEUE_STATES, QUEUE_TRANSITIONS } from './agent/index.js';
import { notificationCenterService } from './notifications/index.js';
import { lifecycleService, LIFECYCLE_STEPS, TIPS_STEPS } from './lifecycle/index.js';
import { deleteEventsForUser, growthService, markChecklistStep, recordAttribution } from './growth/index.js';
import { prepService } from './prep/index.js';
import { coachingService } from './coaching/index.js';
import { campusService } from './cn/campus/index.js';
import { twoFactorService } from './account-v2/index.js';
import { PROTECTED_QUESTION_TYPES } from './extension/index.js';
import { DEFAULT_IMPORT_FETCH_DENYLIST } from './jobs/import/contract.js';

// ── Onboarding contract (R-06) ───────────────────────────────────────────

describe('onboarding contract', () => {
  it('keeps the PRODUCT §4.2/§4.4 stage order per brand', () => {
    expect(onboarding.ROBOAPPLY_ONBOARDING_STAGES).toEqual(['account', 'situation', 'basics', 'goal', 'preferences', 'resume', 'matching', 'confirm', 'tour', 'done']);
    expect(onboarding.GOAPPLY_ONBOARDING_STAGES).toEqual(['account', 'consent', 'identity', 'education', 'intent', 'tags', 'resume', 'matching', 'confirm', 'tour', 'done']);
    for (const brand of ['roboapply', 'goapply'] as const) {
      const orders = onboarding.ONBOARDING_STAGES[brand].map((s) => onboarding.ONBOARDING_STAGE_ORDER[s]);
      expect([...orders].sort((a, b) => a - b)).toEqual(orders);
    }
  });

  it('maps every stage to a route (done → none; confirm is a page)', () => {
    for (const brand of ['roboapply', 'goapply'] as const) {
      for (const stage of onboarding.ONBOARDING_STAGES[brand]) {
        const route = onboarding.ONBOARDING_STAGE_ROUTES[brand][stage];
        if (stage === 'done') expect(route).toBeNull();
        else expect(route, `${brand}.${stage}`).toMatch(/^\//);
      }
    }
    expect(onboarding.ONBOARDING_STAGE_ROUTES.roboapply.confirm).toBe('/onboarding/confirm');
    expect(onboarding.ONBOARDING_STAGE_ROUTES.roboapply.account).toBe('/signup');
  });

  it('skips goal/preferences on the urgent branch only', () => {
    expect(onboarding.nextStage('roboapply', 'basics', 'urgent')).toBe('resume');
    expect(onboarding.nextStage('roboapply', 'basics', 'explore')).toBe('goal');
    expect(onboarding.nextStage('roboapply', 'goal', 'explore')).toBe('preferences');
    expect(onboarding.nextStage('roboapply', 'basics', null)).toBe('resume');
    expect(onboarding.nextStage('goapply', 'tags', null)).toBe('resume');
    expect(onboarding.nextStage('roboapply', 'tour', 'urgent')).toBe('done');
    expect(onboarding.nextStage('roboapply', 'done', 'urgent')).toBe('done');
  });

  it('applies the R-14 first-value fallback on GoApply', () => {
    expect(onboarding.firstValueRoute('roboapply')).toBe('/jobs');
    expect(onboarding.firstValueRoute('goapply', { campusCalendar: true, jobsFeed: true })).toBe('/campus');
    expect(onboarding.firstValueRoute('goapply', { campusCalendar: false, jobsFeed: true })).toBe('/jobs');
    expect(onboarding.firstValueRoute('goapply', {})).toBe('/resume');
    expect(onboarding.firstValueRoute('goapply', { campusCalendar: true, jobsFeed: true, cnIdentity: 'shezhao' })).toBe('/jobs');
    expect(onboarding.routeForStage('goapply', 'tour', { campusCalendar: true })).toBe('/campus');
    expect(onboarding.landingRoute('roboapply', { jobId: 'job 1' })).toBe('/jobs/job%201');
  });

  it('builds /auth/me.onboarding; existing users (default done) are complete', () => {
    expect(onboarding.buildOnboardingMe('roboapply', { onboardingStep: 'done' })).toEqual({ step: 'done', path: null, completed: true, nextRoute: null });
    expect(onboarding.buildOnboardingMe('roboapply', null)).toMatchObject({ completed: true });
    expect(onboarding.buildOnboardingMe('roboapply', { onboardingStep: 'account', onboardingPath: null })).toEqual({
      step: 'account',
      path: null,
      completed: false,
      nextRoute: '/signup',
    });
    expect(onboarding.buildOnboardingMe('roboapply', { onboardingStep: 'goal', onboardingPath: 'explore' })).toEqual({
      step: 'goal',
      path: 'explore',
      completed: false,
      nextRoute: '/onboarding/goal',
    });
    // A GoApply stage stored for a RoboApply user is unknown there → done.
    expect(onboarding.buildOnboardingMe('roboapply', { onboardingStep: 'consent' }).step).toBe('done');
    expect(onboarding.buildOnboardingMe('goapply', { onboardingStep: 'consent', onboardingPath: 'urgent' })).toEqual({
      step: 'consent',
      path: null,
      completed: false,
      nextRoute: '/onboarding/consent',
    });
    expect(onboarding.OnboardingMeSchema.safeParse(onboarding.buildOnboardingMe('goapply', { onboardingStep: 'tour' })).success).toBe(true);
  });

  it('validates RoboApply step bodies', () => {
    const s = onboarding.ROBOAPPLY_STEP_BODY_SCHEMAS;
    expect(s.situation.safeParse({ timing: 'asap', seekerType: 'student' }).success).toBe(true);
    expect(s.situation.safeParse({ timing: 'asap' }).success).toBe(false);
    expect(s.basics.safeParse({ jobFunctions: [], jobTypes: ['full_time'], countries: ['US'] }).success).toBe(false);
    expect(
      s.basics.safeParse({ jobFunctions: [{ label: 'a' }, { label: 'b' }, { label: 'c' }, { label: 'd' }], jobTypes: ['full_time'], countries: ['US'] }).success,
    ).toBe(false);
    expect(s.confirm.safeParse({ experienceLevels: [] }).success).toBe(false);
    expect(s.confirm.safeParse({ experienceLevels: ['mid'], linkedinUrl: 'https://evil.example/in/x' }).success).toBe(false);
    expect(s.confirm.safeParse({ experienceLevels: ['mid'], linkedinUrl: 'https://www.linkedin.com/in/ada' }).success).toBe(true);
  });
});

describe('GoApply onboarding contract (PIPL)', () => {
  const base = { agreement: true, aiProcessing: false, personalizedRecommendation: false, proseVersion: 'v1' };

  it('requires an explicit 个性化推荐 choice and the agreement; nothing defaults to on', () => {
    expect(onboardingCn.CnConsentStepSchema.safeParse(base).success).toBe(true);
    const { personalizedRecommendation: _p, ...noChoice } = base;
    expect(onboardingCn.CnConsentStepSchema.safeParse(noChoice).success).toBe(false);
    expect(onboardingCn.CnConsentStepSchema.safeParse({ ...base, agreement: false }).success).toBe(false);
    const { aiProcessing: _a, ...noAi } = base;
    expect(onboardingCn.CnConsentStepSchema.safeParse(noAi).success).toBe(false);
  });

  it('keeps 届别 within 2025–2030 and salary min ≤ max', () => {
    expect(onboardingCn.CnIdentityStepSchema.safeParse({ cnIdentity: 'yingjie', graduationClass: 2031 }).success).toBe(false);
    expect(onboardingCn.CnIdentityStepSchema.safeParse({ cnIdentity: 'yingjie', graduationClass: 2027 }).success).toBe(true);
    const intent = { targetRoles: [{ label: '产品经理' }], cities: ['上海'], workType: 'full_time' };
    expect(onboardingCn.CnIntentStepSchema.safeParse({ ...intent, salaryMonthlyK: { min: 25, max: 15 } }).success).toBe(false);
    expect(onboardingCn.CnIntentStepSchema.safeParse({ ...intent, salaryMonthlyK: { min: 15, max: 25 }, salaryMonths: 13 }).success).toBe(true);
    expect(onboardingCn.CnIntentStepSchema.safeParse({ ...intent, salaryMonthlyK: 'negotiable' }).success).toBe(true);
  });

  it('exposes the validateCnStep seam (WP-31 fills it)', () => {
    expect(typeof onboardingCn.validateCnStep).toBe('function');
  });
});

// ── Market hooks ─────────────────────────────────────────────────────────

describe('marketHooks', () => {
  const ctx = { brand: 'goapply' as const, market: 'cn' as const, stage: 'ingest' as const };

  it('statically registers the cn and ats_public hook modules (WP-41 / WP-42 fill them in place)', () => {
    expect(MARKET_HOOK_SETS.map((s) => s.id)).toEqual(['cn', 'ats_public']);
    for (const set of MARKET_HOOK_SETS) expect(typeof set.appliesTo).toBe('function');
    // Hooks never apply to the other market's jobs.
    const cnSet = MARKET_HOOK_SETS.find((s) => s.id === 'cn')!;
    expect(cnSet.appliesTo({ market: 'intl', provider: 'activejobs' }, { ...ctx, brand: 'roboapply', market: 'intl' })).toBe(false);
  });

  it('runs only applicable sets, in order, and isolates cardMeta failures', async () => {
    const calls: string[] = [];
    const a: MarketHookSet = {
      id: 'a',
      appliesTo: (j) => j.market === 'cn',
      afterNormalize: (j) => (calls.push('a'), { ...j, tagged: 'a' }),
      cardMeta: () => ({ line: 'A' }),
    };
    const b: MarketHookSet = {
      id: 'b',
      appliesTo: () => true,
      afterNormalize: (j) => (calls.push('b'), { ...j, seen: j.tagged }),
      cardMeta: () => {
        throw new Error('boom');
      },
    };
    const c: MarketHookSet = { id: 'c', appliesTo: () => false, afterNormalize: () => (calls.push('c'), { market: 'intl' }) };
    const out = await afterNormalize({ market: 'cn' }, ctx, [a, b, c]);
    expect(calls).toEqual(['a', 'b']);
    expect(out).toEqual({ market: 'cn', tagged: 'a', seen: 'a' });
    expect(cardMeta({ market: 'cn' }, ctx, [a, b, c])).toEqual({ a: { line: 'A' } });
    const failing: MarketHookSet = { id: 'f', appliesTo: () => true, afterEnrich: async () => Promise.reject(new Error('enrich failed')) };
    await expect(afterEnrich({ market: 'cn' }, ctx, [failing])).rejects.toThrow('enrich failed');
  });
});

// ── Delivery channels (WP-39a extension point) ───────────────────────────

describe('alerts.registerDeliveryChannel', () => {
  const channel = (id: string, brands: Array<'roboapply' | 'goapply'>): DeliveryChannel => ({
    id,
    brands,
    isConfigured: () => true,
    deliver: vi.fn(async () => ({ delivered: true })),
  });

  it('registers channels, filters by brand and refuses a second impl for an id', () => {
    resetDeliveryChannelsForTests();
    const push = channel('web_push', ['roboapply']);
    const wechat = channel('wechat_mp', ['goapply']);
    registerDeliveryChannel('web_push', push);
    registerDeliveryChannel('web_push', push); // idempotent
    registerDeliveryChannel('wechat_mp', wechat);
    expect(deliveryChannels().map((c) => c.id)).toEqual(['web_push', 'wechat_mp']);
    expect(deliveryChannels('goapply')).toEqual([wechat]);
    expect(() => registerDeliveryChannel('web_push', channel('web_push', ['roboapply']))).toThrow(/already registered/);
    expect(() => registerDeliveryChannel('email', push)).toThrow(/mismatch/);
    resetDeliveryChannelsForTests();
  });
});

// ── Stub service interfaces ──────────────────────────────────────────────

describe('area service interfaces', () => {
  const services: Record<string, object> = {
    onboarding: onboarding.onboardingService,
    onboardingCn: onboardingCn.onboardingCnService,
    auth: authFeatureService,
    authCn: authCnService,
    compliance: complianceService,
    profile: profileService,
    feed: feedService,
    jobImport: jobImportService,
    jobDetail: jobDetailService,
    companies: companyService,
    match: matchService,
    copilot: copilotService,
    resume: resumeSuiteService,
    coverLetter: coverLetterService,
    tracker: trackerService,
    offers: offersService,
    network: networkService,
    agent: agentService,
    notifications: notificationCenterService,
    lifecycle: lifecycleService,
    growth: growthService,
    prep: prepService,
    coaching: coachingService,
    campus: campusService,
    twoFactor: twoFactorService,
  };

  it.each(Object.entries(services))('%s exposes at least one method', (_name, service) => {
    const methods = Object.entries(service).filter(([, v]) => typeof v === 'function');
    expect(methods.length).toBeGreaterThan(0);
  });

  it('exposes the named cross-wave seams', () => {
    for (const seam of [handleVisitorTurn, listFeedback, markChecklistStep, recordAttribution, deleteEventsForUser, updateOffer]) {
      expect(typeof seam).toBe('function');
    }
  });
});

// ── Contract invariants that encode product rules ────────────────────────

describe('contract invariants', () => {
  it('D1: no queue state or transition is ever "submitted"', () => {
    expect(QUEUE_STATES as readonly string[]).not.toContain('submitted');
    for (const [from, tos] of Object.entries(QUEUE_TRANSITIONS)) {
      expect(QUEUE_STATES as readonly string[]).toContain(from);
      for (const to of tos) expect(QUEUE_STATES as readonly string[]).toContain(to);
    }
  });

  it('fit tiers follow R-09 (80 / 65 / 45)', () => {
    expect([tierForScore(80), tierForScore(79), tierForScore(65), tierForScore(64), tierForScore(45), tierForScore(44)]).toEqual([
      'great',
      'good',
      'good',
      'possible',
      'possible',
      'unlikely',
    ]);
  });

  it('protected question types never get AI answers (contract list)', () => {
    for (const t of ['work_authorization', 'sponsorship', 'criminal_history', 'eeo', 'salary_expectation', 'years_of_experience', 'clearance', 'notice_period']) {
      expect(PROTECTED_QUESTION_TYPES as readonly string[]).toContain(t);
    }
  });

  it('job import accepts http(s) URLs or manual fields only; LinkedIn is on the fetch denylist', () => {
    expect(ImportJobBodySchema.safeParse({ url: 'https://example.test/job' }).success).toBe(true);
    expect(ImportJobBodySchema.safeParse({ url: 'ftp://example.test/job' }).success).toBe(false);
    expect(ImportJobBodySchema.safeParse({ url: 'https://a.test', manual: {} }).success).toBe(false);
    expect(DEFAULT_IMPORT_FETCH_DENYLIST).toContain('linkedin.com');
  });

  it('an edited tailoring claim needs text', () => {
    expect(UpdateClaimBodySchema.safeParse({ status: 'edited' }).success).toBe(false);
    expect(UpdateClaimBodySchema.safeParse({ status: 'edited', text: 'Led 3 launches' }).success).toBe(true);
  });

  it('card vocabulary includes ARCH §5.4', () => {
    for (const t of ['job_list', 'filters', 'filter_diff', 'fit_analysis', 'company', 'contacts', 'credit_action', 'notice']) {
      expect(CARD_TYPES as readonly string[]).toContain(t);
    }
  });

  it('lifecycle "Tips and reminders" rows are a subset of the steps', () => {
    for (const s of TIPS_STEPS) expect(LIFECYCLE_STEPS).toContain(s);
  });

  it('accepts +86 mainland mobiles only', () => {
    expect(CN_MOBILE_RE.test('13812345678')).toBe(true);
    expect(CN_MOBILE_RE.test('+8613812345678')).toBe(true);
    expect(CN_MOBILE_RE.test('12812345678')).toBe(false);
    expect(CN_MOBILE_RE.test('+886912345678')).toBe(false);
  });
});
