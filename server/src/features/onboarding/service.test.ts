// @vitest-environment node
//
// WP-30: the onboarding service over an in-memory repo and fake collaborators
// (no network, no database). Covers idempotent re-submission, resumability
// across devices, side effects, leaving early, GoApply dispatch, and the O5
// resume seed (daily limit; zero LLM calls without AI consent).

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/prisma.js', () => ({ default: {} }));

import { getBrand } from '../../platform/brand/registry.js';
import { NotImplementedError } from '../../platform/http.js';
import { createOnboardingService, defaultCountry, type OnboardingDeps } from './service.js';
import { SAMPLE_BASICS, createMemoryRepo, createMemorySearchProfiles } from './testkit.js';
import { CONSENT_PROSE_VERSION } from '../compliance/index.js';
import { createOnboardingCnService } from '../onboarding-cn/index.js';

const RA = { brand: getBrand('roboapply') };
const GO = { brand: getBrand('goapply') };

function setup(over: Partial<OnboardingDeps> = {}, seed: Parameters<typeof createMemoryRepo>[0] = { u1: {} }) {
  const mem = createMemoryRepo(seed);
  const sp = createMemorySearchProfiles();
  const profile = { setLinkedin: vi.fn(async () => undefined), setSponsorship: vi.fn(async () => undefined) };
  const applyCnStep = vi.fn(async () => undefined);
  const aiSeedRoles = vi.fn(async () => ['Data analyst']);
  const deps: OnboardingDeps = {
    repo: mem.repo,
    now: () => new Date('2026-10-10T12:00:00Z'),
    searchProfiles: sp.api,
    profile,
    validateCnStep: async () => {
      throw new NotImplementedError('onboardingCn.validateCnStep');
    },
    applyCnStep,
    snapshot: vi.fn(async () => ({ jobCount: { value: 0, source: 'index' as const, asOf: 'x' }, windowDays: 30, pay: null, topSkills: [] })),
    titleSuggest: () => [],
    seedResume: () => ({ roles: [], seniority: null, years: 3 }),
    aiSeedRoles,
    aiAllowed: async () => true,
    consumeResumeQuota: vi.fn(async () => ({ allowed: true, retryAfterSec: 0 })),
    grantFreeResumeCheck: vi.fn(async () => 'granted' as const),
    queueResumeCheck: vi.fn(async () => undefined),
    ...over,
  };
  return { svc: createOnboardingService(deps), mem, sp, profile, deps, aiSeedRoles, applyCnStep };
}

describe('state', () => {
  it('a fresh account starts at situation with a progress count and a header-derived default country', async () => {
    const { svc } = setup();
    const s = await svc.getState('u1', { ...RA, country: 'tw' });
    expect(s).toMatchObject({ stage: 'situation', nextRoute: '/onboarding/situation', branch: null, completed: false, brand: 'roboapply' });
    expect(s.progress).toEqual({ total: 5, stepsLeft: 5, leftEarly: null });
    expect(s.defaults.country).toBe('TW');
  });

  it('default country never guesses: unknown header + en → null; zh-TW → TW', () => {
    expect(defaultCountry('BR', 'en')).toBeNull();
    expect(defaultCountry(null, 'zh-TW')).toBe('TW');
    expect(defaultCountry('us', 'en')).toBe('US');
  });

  it('carries the entry attribution (from, job, action, ref, utm, alert) through the state untouched', async () => {
    const entry = { from: 'job', jobId: 'cjob1', action: 'apply' as const, ref: 'REF1', utmSource: 'news', utmMedium: 'email', utmCampaign: 'oct', alert: 'tok' };
    const { svc } = setup({}, { u1: { entry } });
    expect((await svc.getState('u1', RA)).entry).toEqual(entry);
    await svc.saveStep('u1', 'situation', { timing: 'asap', seekerType: 'experienced' }, RA);
    expect((await svc.getState('u1', RA)).entry).toEqual(entry);
  });

  it('existing users (default done) are complete', async () => {
    const { svc } = setup({}, { u1: { step: 'done' } });
    expect(await svc.getState('u1', RA)).toMatchObject({ stage: 'done', completed: true, nextRoute: null });
    expect(await svc.meFor('u1', 'roboapply')).toEqual({ step: 'done', path: null, completed: true, nextRoute: null });
  });
});

describe('steps', () => {
  it('situation sets the branch and the seeker type; explore adds goal', async () => {
    const { svc, mem } = setup();
    const res = await svc.saveStep('u1', 'situation', { timing: 'just_looking', seekerType: 'student' }, RA);
    expect(res).toEqual({ stage: 'basics', nextStage: 'basics', nextRoute: '/onboarding/basics' });
    expect(mem.rows.get('u1')).toMatchObject({ step: 'basics', path: 'explore', seekerType: 'student' });
    const b = await svc.saveStep('u1', 'basics', { ...SAMPLE_BASICS }, RA);
    expect(b.nextRoute).toBe('/onboarding/goal');
  });

  it('re-submitting a step is idempotent: same answers, same filters, no duplicates', async () => {
    const { svc, mem, sp } = setup();
    await svc.saveStep('u1', 'situation', { timing: 'asap', seekerType: 'experienced' }, RA);
    await svc.saveStep('u1', 'basics', { ...SAMPLE_BASICS }, RA);
    const first = JSON.stringify({ a: mem.rows.get('u1')!.answers, f: sp.state.filters });
    await svc.saveStep('u1', 'basics', { ...SAMPLE_BASICS }, RA);
    expect(JSON.stringify({ a: mem.rows.get('u1')!.answers, f: sp.state.filters })).toBe(first);
    expect(sp.state.filters).toMatchObject({ taxonomyIds: ['backend_engineer'], jobTypes: ['full_time'], country: 'US' });
    expect(mem.rows.get('u1')!.step).toBe('resume');
  });

  it('is resumable across devices (a second service instance continues from the stored stage)', async () => {
    const { svc, deps } = setup();
    await svc.saveStep('u1', 'situation', { timing: 'asap', seekerType: 'experienced' }, RA);
    const otherDevice = createOnboardingService(deps);
    expect((await otherDevice.getState('u1', RA)).nextRoute).toBe('/onboarding/basics');
  });

  it('validation errors are 422 with issues; situation cannot be skipped; no jumping ahead', async () => {
    const { svc } = setup();
    await expect(svc.saveStep('u1', 'situation', { timing: 'soon' }, RA)).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(svc.saveStep('u1', 'situation', { skip: true }, RA)).rejects.toMatchObject({ code: 'invalid_request', details: { reason: 'onboarding_step_required' } });
    await expect(svc.saveStep('u1', 'confirm', { experienceLevels: ['mid'] }, RA)).rejects.toMatchObject({ code: 'conflict', details: { reason: 'onboarding_step_not_available' } });
    await expect(svc.saveStep('u1', 'consent', {}, RA)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('Skip keeps every valid field that was entered (field by field) and records the skip', async () => {
    const { svc, mem, sp } = setup({}, { u1: { step: 'basics', path: 'explore' } });
    const res = await svc.saveStep('u1', 'basics', { skip: true, jobFunctions: [], jobTypes: ['contract'], countries: 'nope' }, RA);
    expect(res.nextStage).toBe('goal');
    expect(mem.rows.get('u1')!.answers).toMatchObject({ basics: { jobTypes: ['contract'] }, skipped: ['basics'] });
    expect(mem.rows.get('u1')!.answers.basics).not.toHaveProperty('countries');
    expect(mem.rows.get('u1')!.answers.basics).not.toHaveProperty('jobFunctions');
    // Only the answered field reaches the search profile; titles and places are left alone.
    expect(sp.state.patches).toEqual([{ jobTypes: ['contract'] }]);
    await svc.saveStep('u1', 'goal', { skip: true }, RA);
    expect(mem.rows.get('u1')!.careerGoal).toBeNull();
    await svc.saveStep('u1', 'preferences', { skip: true, skills: ['SQL'] }, RA);
    expect(sp.state.filters).toMatchObject({ skills: ['SQL'] });
  });

  it('Skip with no title found keeps the chosen countries, job types and remote setting', async () => {
    const { svc, mem, sp } = setup({}, { u1: { step: 'basics', path: 'urgent' } });
    await svc.saveStep('u1', 'basics', { skip: true, jobTypes: ['full_time', 'contract'], countries: ['TW', 'JP'], remoteOk: false }, RA);
    expect(mem.rows.get('u1')!.answers.basics).toEqual({ jobTypes: ['full_time', 'contract'], countries: ['TW', 'JP'], remoteOk: false });
    expect(sp.state.filters).toMatchObject({ jobTypes: ['full_time', 'contract'], workModels: ['hybrid', 'onsite'] });
    expect(sp.state.filters.locations).toEqual([
      { label: 'TW', country: 'TW', radiusKm: 0 },
      { label: 'JP', country: 'JP', radiusKm: 0 },
    ]);
    expect(sp.state.filters).not.toHaveProperty('taxonomyIds');
    // O6 re-applies the same valid subset.
    await svc.applyAnswers('u1', RA);
    expect(sp.state.patches.at(-1)).toMatchObject({ jobTypes: ['full_time', 'contract'], country: null });
    expect(sp.state.patches.at(-1)).not.toHaveProperty('taxonomyIds');
  });

  it('confirm writes levels, the email summary, LinkedIn and the acquisition answer, then lands on the carried job', async () => {
    const { svc, mem, sp, profile } = setup({}, { u1: { step: 'confirm', path: 'urgent', entry: { jobId: 'cjob9' }, answers: { basics: { ...SAMPLE_BASICS, jobFunctions: [...SAMPLE_BASICS.jobFunctions], jobTypes: ['full_time'], countries: ['US'] } } } });
    const res = await svc.confirm(
      'u1',
      { experienceLevels: ['senior'], alertFrequency: 'weekly', linkedinUrl: 'https://www.linkedin.com/in/sample-person', heardFrom: 'friend' },
      RA,
    );
    expect(res).toEqual({ stage: 'tour', nextRoute: '/jobs/cjob9' });
    expect(sp.state.filters).toMatchObject({ seniority: ['senior'] });
    expect(sp.state.alertDigest).toBe('weekly');
    expect(profile.setLinkedin).toHaveBeenCalledWith('u1', 'https://www.linkedin.com/in/sample-person', RA.brand);
    expect(mem.rows.get('u1')).toMatchObject({ step: 'tour', acquisitionSource: 'friend' });
    const off = setup({}, { u1: { step: 'confirm', path: 'urgent' } });
    await off.svc.confirm('u1', { experienceLevels: ['mid'], alertFrequency: 'off' }, RA);
    expect(off.sp.state.alertDigest).toBeNull();
    const dflt = setup({}, { u1: { step: 'confirm', path: 'urgent' } });
    await dflt.svc.confirm('u1', { experienceLevels: ['mid'] }, RA);
    expect(dflt.sp.state.alertDigest).toBe('daily');
  });

  it('retries a search-profile version race once', async () => {
    const { svc, sp } = setup();
    const update = sp.api.update;
    let raced = false;
    sp.api.update = async (...args) => {
      if (!raced) {
        raced = true;
        sp.state.version += 1;
      }
      return update(...args);
    };
    await svc.saveStep('u1', 'situation', { timing: 'asap', seekerType: 'experienced' }, RA);
    await svc.saveStep('u1', 'basics', { ...SAMPLE_BASICS }, RA);
    expect(sp.state.filters).toMatchObject({ jobTypes: ['full_time'] });
  });
});

describe('complete, skip and leaving early', () => {
  it('complete needs the tour; then done with the landing route', async () => {
    const early = setup({}, { u1: { step: 'basics', path: 'urgent' } });
    await expect(early.svc.complete('u1', RA)).rejects.toMatchObject({ code: 'conflict', details: { reason: 'onboarding_not_finished' } });
    const { svc, mem } = setup({}, { u1: { step: 'tour' } });
    expect(await svc.complete('u1', RA)).toEqual({ stage: 'done', nextRoute: '/jobs' });
    expect(mem.rows.get('u1')!.completedAt).toBeInstanceOf(Date);
  });

  it('leaving early stores the stage, shows steps left, and a later save resumes', async () => {
    const { svc, mem } = setup({}, { u1: { step: 'basics', path: 'urgent', entry: { jobId: 'cjob1' } } });
    expect(await svc.skip('u1', RA)).toEqual({ stage: 'done', nextRoute: '/jobs' });
    expect(mem.rows.get('u1')!.step).toBe('done');
    const s = await svc.getState('u1', RA);
    expect(s).toMatchObject({ stage: 'basics', completed: false, nextRoute: '/onboarding/basics' });
    expect(s.progress).toMatchObject({ stepsLeft: 4, leftEarly: { stage: 'basics' } });
    expect(await svc.meFor('u1', 'roboapply')).toMatchObject({ completed: true, nextRoute: null });
    await svc.saveStep('u1', 'basics', { ...SAMPLE_BASICS }, RA);
    expect(mem.rows.get('u1')).toMatchObject({ step: 'resume' });
    expect(mem.rows.get('u1')!.answers.leftEarly).toBeUndefined();
  });

  it('skip from the tour finishes; skip when done is a no-op', async () => {
    const { svc, mem } = setup({}, { u1: { step: 'tour' } });
    await svc.skip('u1', RA);
    expect(mem.rows.get('u1')!.completedAt).toBeInstanceOf(Date);
    await svc.skip('u1', RA);
    expect(mem.rows.get('u1')!.answers.leftEarly).toBeUndefined();
  });

  it('a user with no seeker profile gets 404', async () => {
    const { svc } = setup({}, {});
    await expect(svc.getState('nobody', RA)).rejects.toMatchObject({ code: 'not_found' });
    await expect(svc.skip('nobody', RA)).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('GoApply steps go through onboarding-cn', () => {
  it('answers 501 while the WP-31 seam is a stub', async () => {
    const { svc } = setup();
    await expect(svc.saveStep('u1', 'consent', { agreement: true }, GO)).rejects.toMatchObject({ code: 'not_implemented' });
  });

  it('stores the validated answers and hands the whole WP-31 result (effects included) to applyCnStep', async () => {
    const result = {
      ok: true,
      answers: { cnIdentity: 'yingjie', graduationClass: 2027 },
      effects: { consents: [], cnFields: { identity: 'yingjie', graduationClass: 2027 }, filterPatch: { classYear: 2027 } },
    };
    const validateCnStep = vi.fn(async () => result);
    const { svc, mem, applyCnStep } = setup({ validateCnStep }, { u1: { step: 'identity', answers: { consent: { agreement: true } } } });
    const res = await svc.saveStep('u1', 'identity', { cnIdentity: 'yingjie', graduationClass: 2027 }, { ...GO, locale: 'zh' });
    expect(res).toEqual({ stage: 'education', nextStage: 'education', nextRoute: '/onboarding/education' });
    expect(validateCnStep).toHaveBeenCalledWith('identity', { cnIdentity: 'yingjie', graduationClass: 2027 }, { answers: { consent: { agreement: true } } });
    expect(mem.rows.get('u1')!.answers.identity).toEqual({ cnIdentity: 'yingjie', graduationClass: 2027 });
    expect(applyCnStep).toHaveBeenCalledWith('u1', GO.brand, result, { locale: 'zh' });
    expect(mem.rows.get('u1')!.path).toBeNull();
  });

  describe('with the real WP-31 validator and writer', () => {
    function realCn(seed: Parameters<typeof createMemoryRepo>[0]) {
      const recordConsent = vi.fn(async () => ({}));
      const patchCnFields = vi.fn(async () => ({}));
      const patchDefaultFilters = vi.fn(async () => ({}));
      const cn = createOnboardingCnService({ recordConsent, patchCnFields, patchDefaultFilters });
      const t = setup({ validateCnStep: (step, body, ctx) => cn.validateCnStep(step, body, ctx), applyCnStep: (u, b, r, o) => cn.applyCnStep(u, b, r, o) }, seed);
      return { ...t, recordConsent, patchCnFields, patchDefaultFilters };
    }

    it('G1 consent writes the six consent records to the ledger with the prose version shown', async () => {
      const prev = process.env.DEPLOY_REGION;
      delete process.env.DEPLOY_REGION; // offshore deployment: the cross-border record is required
      try {
        const { svc, recordConsent } = realCn({ u1: { step: 'consent' } });
        const body = { agreement: true, crossBorder: true, aiProcessing: true, personalizedRecommendation: true, marketing: false, proseVersion: CONSENT_PROSE_VERSION };
        await svc.saveStep('u1', 'consent', body, { ...GO, locale: 'zh' });
        const types = recordConsent.mock.calls.map((c) => {
          const input = (c as unknown as [{ type: string; granted: boolean; proseVersion: string; locale: string }])[0];
          expect(input).toMatchObject({ userId: 'u1', proseVersion: CONSENT_PROSE_VERSION, locale: 'zh' });
          return `${input.type}:${input.granted}`;
        });
        expect(types.sort()).toEqual(
          ['age_16_plus:true', 'ai_resume_parsing:true', 'marketing_email:false', 'personalized_recommendation:true', 'pipl_basic_processing:true', 'pipl_cross_border:true'].sort(),
        );
      } finally {
        if (prev === undefined) delete process.env.DEPLOY_REGION;
        else process.env.DEPLOY_REGION = prev;
      }
    });

    it('a 应届 student (stored G2 identity) cannot skip G3 education: 422', async () => {
      const { svc, patchCnFields } = realCn({ u1: { step: 'education', answers: { identity: { cnIdentity: 'yingjie', graduationClass: 2027 } } } });
      await expect(svc.saveStep('u1', 'education', { skip: true }, GO)).rejects.toMatchObject({ code: 'invalid_request', details: { issues: [{ path: ['skip'] }] } });
      expect(patchCnFields).not.toHaveBeenCalled();
    });

    it('G2 identity writes cnFields and the default-filter patch', async () => {
      const { svc, patchCnFields, patchDefaultFilters } = realCn({ u1: { step: 'identity' } });
      await svc.saveStep('u1', 'identity', { cnIdentity: 'yingjie', graduationClass: 2027 }, GO);
      expect(patchCnFields).toHaveBeenCalledWith('u1', GO.brand, expect.objectContaining({ identity: 'yingjie', graduationClass: 2027 }));
      expect(patchDefaultFilters).toHaveBeenCalledTimes(1);
    });
  });

  it('refused answers are 422 with the validator issues', async () => {
    const validateCnStep = vi.fn(async () => ({ ok: false, issues: [{ path: ['graduationClass'], message: 'out of range' }] }));
    const { svc } = setup({ validateCnStep }, { u1: { step: 'identity' } });
    await expect(svc.saveStep('u1', 'identity', {}, GO)).rejects.toMatchObject({ code: 'invalid_request', details: { issues: [{ path: ['graduationClass'] }] } });
  });
});

describe('POST /onboarding/resume (O5 seed)', () => {
  const md = '# Sample Person\n\n## Experience\nAnalyst at Example Co, 2021–2024';

  it('suggests levels, titles and skills, stores them, and queues the free check', async () => {
    const { svc, mem, deps } = setup({ seedResume: () => ({ roles: ['Backend Engineer'], seniority: 'senior', years: 7 }) });
    mem.addResume('u1', { id: 'rv1', parsedData: { skills: ['Go', 'Kubernetes'] }, resumeMarkdown: md });
    const res = await svc.resume('u1', 'rv1', RA);
    expect(res).toEqual({
      suggestedSeniority: ['senior'],
      suggestedTaxonomyIds: ['backend_engineer'],
      suggestedSkills: ['Go', 'Kubernetes'],
      profileDraft: { targetRoles: ['Backend Engineer'], years: 7, aiSuggested: false },
    });
    expect(mem.rows.get('u1')!.answers.resumeSuggestions).toMatchObject({ resumeVariantId: 'rv1' });
    expect(deps.grantFreeResumeCheck).toHaveBeenCalledWith('u1');
    expect(deps.queueResumeCheck).toHaveBeenCalledWith('u1', 'rv1', 'Backend Engineer');
  });

  it('queues the free check once: a second resume (swap, Back, re-seed) never spends a paid check', async () => {
    let granted = false;
    const grantFreeResumeCheck = vi.fn(async () => {
      if (granted) return 'already_granted' as const;
      granted = true;
      return 'granted' as const;
    });
    const { svc, mem, deps } = setup({ grantFreeResumeCheck, seedResume: () => ({ roles: ['Backend Engineer'], seniority: null, years: 3 }) });
    mem.addResume('u1', { id: 'rv1', parsedData: null, resumeMarkdown: md });
    mem.addResume('u1', { id: 'rv2', parsedData: null, resumeMarkdown: md });
    await svc.resume('u1', 'rv1', RA);
    await svc.resume('u1', 'rv2', RA);
    await svc.resume('u1', 'rv1', RA);
    expect(grantFreeResumeCheck).toHaveBeenCalledTimes(3);
    expect(deps.queueResumeCheck).toHaveBeenCalledTimes(1);
    expect(deps.queueResumeCheck).toHaveBeenCalledWith('u1', 'rv1', 'Backend Engineer');
  });

  it('a failing grant or queue never fails the seed', async () => {
    const warn = vi.fn();
    const { svc, mem } = setup({ grantFreeResumeCheck: async () => Promise.reject(new Error('credits down')), warn });
    mem.addResume('u1', { id: 'rv1', parsedData: null, resumeMarkdown: md });
    await expect(svc.resume('u1', 'rv1', RA)).resolves.toMatchObject({ suggestedSeniority: ['mid'] });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('refuses once setup is finished (no seed, no quota, no check)', async () => {
    const { svc, mem, deps } = setup({}, { u1: { step: 'done', completedAt: new Date('2026-10-01T00:00:00Z') } });
    mem.addResume('u1', { id: 'rv1', parsedData: null, resumeMarkdown: md });
    await expect(svc.resume('u1', 'rv1', RA)).rejects.toMatchObject({ code: 'conflict', details: { reason: 'onboarding_step_not_available' } });
    const tour = setup({}, { u1: { step: 'tour' } });
    tour.mem.addResume('u1', { id: 'rv1', parsedData: null, resumeMarkdown: md });
    await expect(tour.svc.resume('u1', 'rv1', RA)).rejects.toMatchObject({ code: 'conflict' });
    expect(deps.consumeResumeQuota).not.toHaveBeenCalled();
    expect(deps.queueResumeCheck).not.toHaveBeenCalled();
  });

  it('back on O5 from O7 (stage confirm) may still pick another resume', async () => {
    const { svc, mem } = setup({}, { u1: { step: 'confirm', path: 'urgent' } });
    mem.addResume('u1', { id: 'rv1', parsedData: null, resumeMarkdown: md });
    await expect(svc.resume('u1', 'rv1', RA)).resolves.toBeTruthy();
  });

  it('uses the AI only when no title was readable, and labels the result as AI', async () => {
    const { svc, mem, aiSeedRoles } = setup();
    mem.addResume('u1', { id: 'rv1', parsedData: null, resumeMarkdown: md });
    const res = await svc.resume('u1', 'rv1', RA);
    expect(aiSeedRoles).toHaveBeenCalledTimes(1);
    expect(res.profileDraft).toMatchObject({ targetRoles: ['Data analyst'], aiSuggested: true });
  });

  it('makes zero LLM calls when AI is not allowed (GoApply without consent)', async () => {
    const { svc, mem, aiSeedRoles } = setup({ aiAllowed: async () => false });
    mem.addResume('u1', { id: 'rv1', parsedData: null, resumeMarkdown: md });
    const res = await svc.resume('u1', 'rv1', GO);
    expect(aiSeedRoles).not.toHaveBeenCalled();
    expect(res.profileDraft).toMatchObject({ targetRoles: [], aiSuggested: false });
  });

  it('enforces the persisted daily limit, 404s an unknown resume and 422s an unreadable one', async () => {
    const limited = setup({ consumeResumeQuota: async () => ({ allowed: false, retryAfterSec: 3600 }) });
    limited.mem.addResume('u1', { id: 'rv1', parsedData: null, resumeMarkdown: md });
    await expect(limited.svc.resume('u1', 'rv1', RA)).rejects.toMatchObject({ code: 'rate_limited', details: { reason: 'onboarding_resume_daily_limit' } });
    const { svc, mem, deps } = setup();
    await expect(svc.resume('u1', 'missing', RA)).rejects.toMatchObject({ code: 'not_found' });
    mem.addResume('u1', { id: 'rv2', parsedData: null, resumeMarkdown: '   ' });
    await expect(svc.resume('u1', 'rv2', RA)).rejects.toMatchObject({ code: 'invalid_request', details: { reason: 'onboarding_resume_unusable' } });
    // A bad id never spends one of the daily uses.
    expect(deps.consumeResumeQuota).not.toHaveBeenCalled();
  });
});

describe('market snapshot is scoped to the brand market', () => {
  it('passes the request brand market, never a client value', async () => {
    const { svc, deps } = setup();
    await svc.marketSnapshot({ taxonomyId: 'backend_engineer', country: 'US' }, GO);
    expect(deps.snapshot).toHaveBeenCalledWith({ market: 'cn', taxonomyId: 'backend_engineer', country: 'US' });
  });
});
