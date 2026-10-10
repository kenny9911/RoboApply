// @vitest-environment node
//
// WP-31 server: GoApply onboarding validators, 届别 defaults, K/月·N薪
// parsing, the sourced data files, the cn market snapshot (D3), the
// 个性化推荐 feed seam, the step effects writer (manual mode: zero LLM calls)
// and the rule that school marks never reach ranking. No network, no database
// (fake Prisma), no LLM (LLMService is mocked and must never be called).

import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '../../generated/prisma/client.js';

const llm = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../../services/llm/LLMService.js', () => {
  const fn = () => {
    llm.calls++;
    throw new Error('LLMService must not be called by onboarding-cn');
  };
  const service = new Proxy({}, { get: () => fn });
  return { LLMService: service, llmService: service, default: service };
});

import { createFakePrisma } from '../../test/fakePrisma.js';
import { MIN_SAMPLE } from '../../platform/http.js';
import { getBrand } from '../../platform/brand/registry.js';
import { CONSENT_PROSE_VERSION } from '../compliance/index.js';
import { buildMatchUser, getMatchTiers, getMatchWeights, preScore, toMatchJob, type MatchJobRecord } from '../match/index.js';
import {
  applyCnStep,
  classYearOptions,
  consentsGivenToCurrentText,
  cnCampusWhere,
  cnFirstValueContext,
  cnJobWhere,
  cnMarketSnapshot,
  createOnboardingCnService,
  currentCampusClass,
  feedSortFor,
  findSchool,
  NOT_FRAUD_FLAGGED,
  formatMonthlyK,
  INDUSTRIES,
  INDUSTRIES_SOURCE,
  median,
  onboardingCnService,
  parseMonthlyKSalary,
  PROVINCES,
  PROVINCES_SOURCE,
  provinceOfCity,
  quantile,
  rankingModeFor,
  rankingModeForUser,
  SCHOOLS,
  SCHOOLS_SOURCE,
  schoolTagsFor,
  searchSchools,
  toOnboardingSnapshot,
  validateCnStep,
  CnConsentStepSchema,
  CnIdentityStepSchema,
  CN_SALARY_K_OPTIONS,
  CN_INTERN_DAILY_OPTIONS,
  type CnStepValidation,
} from './index.js';
import { firstValueRoute } from '../onboarding/contract.js';
import { mergeMoeRows, parseMoeCsv } from './buildSchools.js';

const OFFSHORE = {} as Record<string, string | undefined>;
const MAINLAND = { DEPLOY_REGION: 'cn-mainland' };
const OCT_2026 = new Date('2026-10-10T04:00:00Z');
const GO = getBrand('goapply');

const consentBody = (over: Record<string, unknown> = {}) => ({
  agreement: true,
  crossBorder: true,
  aiProcessing: false,
  personalizedRecommendation: false,
  proseVersion: CONSENT_PROSE_VERSION,
  ...over,
});
const answersFor = (cnIdentity: 'yingjie' | 'zaixiao' | 'shezhao') => ({ identity: { cnIdentity } });
const ok = (v: CnStepValidation) => {
  expect(v.issues ?? []).toEqual([]);
  expect(v.ok).toBe(true);
  return v;
};
const issuesOf = (v: CnStepValidation) => (v.issues ?? []).map((i) => `${i.path.join('.')}:${i.message}`);

// ── 届别 ──────────────────────────────────────────────────────────────────

describe('届别 defaults', () => {
  it('Oct 2026 → 2027届 for 应届 and 2028届 for 在校', () => {
    expect(currentCampusClass(OCT_2026)).toBe(2027);
    expect(onboardingCnService.defaultGraduationClass('yingjie', OCT_2026)).toBe(2027);
    expect(onboardingCnService.defaultGraduationClass('zaixiao', OCT_2026)).toBe(2028);
  });

  it('rolls over in July, China time', () => {
    expect(currentCampusClass(new Date('2026-06-30T15:59:00Z'))).toBe(2026); // 23:59 CST, 30 June
    expect(currentCampusClass(new Date('2026-06-30T16:00:00Z'))).toBe(2027); // 00:00 CST, 1 July
    expect(currentCampusClass(new Date('2026-03-01T00:00:00Z'))).toBe(2026);
  });

  it('clamps to the 2025–2030 range the product offers', () => {
    expect(onboardingCnService.defaultGraduationClass('zaixiao', new Date('2030-09-01T00:00:00Z'))).toBe(2030);
    expect(onboardingCnService.defaultGraduationClass('yingjie', new Date('2020-01-01T00:00:00Z'))).toBe(2025);
    expect(classYearOptions()).toEqual([2025, 2026, 2027, 2028, 2029, 2030]);
  });
});

// ── K/月·N薪 ──────────────────────────────────────────────────────────────

describe('K/月·N薪 parsing', () => {
  it.each([
    ['15-25K·13薪', { kind: 'range', min: 15, max: 25, months: 13 }],
    ['15k-25k', { kind: 'range', min: 15, max: 25, months: null }],
    ['15K-25K/月', { kind: 'range', min: 15, max: 25, months: null }],
    ['1.5-2.5万', { kind: 'range', min: 15, max: 25, months: null }],
    ['1.5万-2.5万·14薪', { kind: 'range', min: 15, max: 25, months: 14 }],
    ['20K', { kind: 'range', min: 20, max: 20, months: null }],
    ['8.5-12K·16薪', { kind: 'range', min: 8.5, max: 12, months: 16 }],
    ['１５－２５Ｋ・１３薪', { kind: 'range', min: 15, max: 25, months: 13 }],
    ['面议', { kind: 'negotiable' }],
  ])('%s', (text, expected) => {
    expect(parseMonthlyKSalary(text)).toEqual(expected);
  });

  it.each(['', '200元/天', '25-15K', '15-25K·30薪', '年薪30万', 'competitive'])('reads %j as unknown (never a guess)', (text) => {
    expect(parseMonthlyKSalary(text)).toBeNull();
  });

  it('formats the one display form', () => {
    expect(formatMonthlyK({ min: 15, max: 25 }, 13)).toBe('15-25K·13薪');
    expect(formatMonthlyK({ min: 20, max: 20 })).toBe('20K');
    expect(formatMonthlyK('negotiable')).toBe('面议');
    expect(formatMonthlyK({ kind: 'range', min: 8, max: 12, months: 14 })).toBe('8-12K·14薪');
  });

  it('option grids match PRODUCT G4', () => {
    expect(CN_SALARY_K_OPTIONS.slice(0, 3)).toEqual([1, 2, 3]);
    expect(CN_SALARY_K_OPTIONS).toContain(30);
    expect(CN_SALARY_K_OPTIONS).not.toContain(31);
    expect(CN_SALARY_K_OPTIONS.slice(-2)).toEqual([95, 100]);
    expect(CN_INTERN_DAILY_OPTIONS[0]).toBe(100);
    expect(CN_INTERN_DAILY_OPTIONS.at(-1)).toBe(1000);
    expect(CN_INTERN_DAILY_OPTIONS).not.toContain(125);
  });

  it('median and quantiles', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBeNull();
    expect(quantile([1, 2, 3, 4, 5], 0.25)).toBe(2);
  });
});

// ── Sourced data files ────────────────────────────────────────────────────

describe('data files (D3: every file states its source and whether it was checked)', () => {
  it('carry source and coverage; no "as of" date until checked against the official publication', () => {
    for (const s of [SCHOOLS_SOURCE, PROVINCES_SOURCE, INDUSTRIES_SOURCE]) {
      expect(s.name.length).toBeGreaterThan(4);
      expect(s.compiledAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(s.coverage.length).toBeGreaterThan(10);
      if (s.verified) expect(s.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      else expect(s.asOf).toBeNull();
    }
    // Compiled without the official files at hand (owner request: verify them).
    expect(SCHOOLS_SOURCE.verified).toBe(false);
    expect(SCHOOLS_SOURCE.name).toContain('尚未');
  });

  it('schools: the official list sizes (985 = 39, 211 = 112 + 3 split campuses, 双一流 = 147)', () => {
    const count = (t: string) => SCHOOLS.filter((s) => (s.tags as string[]).includes(t)).length;
    expect(SCHOOLS).toHaveLength(147);
    expect(count('985')).toBe(39);
    expect(count('211')).toBe(115);
    expect(count('double_first_class')).toBe(147);
    expect(new Set(SCHOOLS.map((s) => s.id)).size).toBe(147);
    // 985 ⊂ 211 ⊂ 双一流 on the official lists.
    for (const s of SCHOOLS) if ((s.tags as string[]).includes('985')) expect(s.tags).toContain('211');
  });

  it('school typeahead: prefix first, aliases, full/half-width', () => {
    expect(searchSchools('北京')[0]!.name).toBe('北京大学');
    expect(searchSchools('复旦').map((s) => s.name)).toEqual(['复旦大学']);
    expect(findSchool('上海体育大学')?.name).toBe('上海体育学院');
    expect(findSchool('中国矿业大学(北京)')?.name).toBe('中国矿业大学（北京）');
    expect(schoolTagsFor('清华大学')).toEqual(['985', '211', 'double_first_class']);
    expect(schoolTagsFor('某某职业技术学院')).toEqual([]);
    expect(searchSchools('', 5)).toEqual([]);
  });

  it('provinces: all 34 provincial-level divisions (31 mainland + 台湾 + 2 SARs), 333 mainland prefecture-level divisions, no city tiers', () => {
    expect(PROVINCES).toHaveLength(34);
    // GB/T 2260 order: 台湾 (71) comes after the mainland divisions and before 香港 (81) and 澳门 (82).
    expect(PROVINCES.slice(-3).map((p) => `${p.code}:${p.name}`)).toEqual(['71:台湾', '81:香港', '82:澳门']);
    expect(new Set(PROVINCES.map((p) => p.code)).size).toBe(34);
    // GB/T 2260 gives no sub-divisions for 台湾: it is one place here, like the SARs; nothing is invented.
    expect(PROVINCES.find((p) => p.name === '台湾')).toEqual({ code: '71', name: '台湾', type: 'province', cities: ['台湾'] });
    expect(provinceOfCity('台湾')?.code).toBe('71');
    const mainland = PROVINCES.filter((p) => !['71', '81', '82'].includes(p.code));
    expect(mainland).toHaveLength(31);
    const prefecture = mainland.filter((p) => p.type !== 'municipality').reduce((n, p) => n + p.cities.length, 0);
    expect(prefecture).toBe(333);
    expect(JSON.stringify(PROVINCES)).not.toMatch(/一线|新一线|tier/i);
    expect(provinceOfCity('苏州')?.name).toBe('江苏');
    expect(provinceOfCity('上海')?.name).toBe('上海');
    expect(provinceOfCity('仙桃')?.name).toBe('湖北');
  });

  it('industries: GB/T 4754 sections A–T', () => {
    expect(INDUSTRIES.map((i) => i.code).join('')).toBe('ABCDEFGHIJKLMNOPQRST');
  });

  it('buildSchools merges the MOE list without inventing marks', () => {
    const csv = ['北京市（92所）,,,,,,', '1,北京大学,4111010001,教育部,北京市,本科,', '2,北京某学院,4111019999,北京市,北京市,专科,民办'].join('\n');
    const rows = parseMoeCsv(csv);
    expect(rows).toEqual([
      { name: '北京大学', code: '4111010001', province: '北京' },
      { name: '北京某学院', code: '4111019999', province: '北京' },
    ]);
    const merged = mergeMoeRows(SCHOOLS, rows);
    expect(merged.find((s) => s.name === '北京大学')).toMatchObject({ tags: ['985', '211', 'double_first_class'], moeCode: '4111010001' });
    expect(merged.find((s) => s.name === '北京某学院')).toMatchObject({ tags: [], province: '北京' });
  });
});

// ── G1 consent ────────────────────────────────────────────────────────────

describe('G1 授权说明', () => {
  it('nothing is pre-checked: 个性化推荐 and AI processing must be explicit choices', async () => {
    const { personalizedRecommendation: _p, ...noChoice } = consentBody();
    await expect(validateCnStep('consent', noChoice, { env: OFFSHORE })).resolves.toMatchObject({ ok: false });
    expect(CnConsentStepSchema.safeParse({ ...consentBody(), personalizedRecommendation: undefined }).success).toBe(false);
    const { aiProcessing: _a, ...noAi } = consentBody();
    expect(CnConsentStepSchema.safeParse(noAi).success).toBe(false);
    expect(CnConsentStepSchema.safeParse({ ...consentBody(), agreement: false }).success).toBe(false);
  });

  it('CN-0 requires the cross-border consent; a mainland deployment does not ask it', async () => {
    const offshore = await validateCnStep('consent', consentBody({ crossBorder: false }), { env: OFFSHORE });
    expect(issuesOf(offshore)).toEqual(['crossBorder:required']);
    const missing = await validateCnStep('consent', consentBody({ crossBorder: undefined }), { env: OFFSHORE });
    expect(missing.ok).toBe(false);
    const mainland = ok(await validateCnStep('consent', consentBody({ crossBorder: undefined }), { env: MAINLAND }));
    expect(mainland.effects!.consents.map((c) => c.type)).not.toContain('pipl_cross_border');
    expect(mainland.answers).not.toHaveProperty('crossBorder');
  });

  it('refuses an outdated prose version (the user must see the current text)', async () => {
    const v = await validateCnStep('consent', consentBody({ proseVersion: 'old' }), { env: OFFSHORE });
    expect(issuesOf(v)).toEqual(['proseVersion:onboarding_cn_prose_outdated']);
  });

  it('records one consent per answer; marketing stays off unless tapped', async () => {
    const v = ok(await validateCnStep('consent', consentBody({ personalizedRecommendation: true }), { env: OFFSHORE }));
    expect(v.effects!.consents).toEqual([
      { type: 'pipl_basic_processing', granted: true },
      { type: 'age_16_plus', granted: true },
      { type: 'pipl_cross_border', granted: true },
      { type: 'ai_resume_parsing', granted: false },
      { type: 'personalized_recommendation', granted: true },
      { type: 'marketing_email', granted: false },
    ]);
    expect(v.answers).toMatchObject({ marketing: false, aiProcessing: false, personalizedRecommendation: true });
  });
});

// ── G2 identity ───────────────────────────────────────────────────────────

describe('G2 你的身份', () => {
  it('届别 range 2025–2030', () => {
    expect(CnIdentityStepSchema.safeParse({ cnIdentity: 'yingjie', graduationClass: 2024 }).success).toBe(false);
    expect(CnIdentityStepSchema.safeParse({ cnIdentity: 'yingjie', graduationClass: 2031 }).success).toBe(false);
    expect(CnIdentityStepSchema.safeParse({ cnIdentity: 'yingjie', graduationClass: 2025 }).success).toBe(true);
    expect(CnIdentityStepSchema.safeParse({ cnIdentity: 'yingjie', graduationClass: 2030 }).success).toBe(true);
  });

  it('应届/在校 need a 届别; month defaults to 6; 社招 fields are dropped', async () => {
    expect(issuesOf(await validateCnStep('identity', { cnIdentity: 'zaixiao' }))).toEqual(['graduationClass:required']);
    const v = ok(await validateCnStep('identity', { cnIdentity: 'yingjie', graduationClass: 2027, yearsExperience: '1-3' }));
    expect(v.answers).toEqual({ cnIdentity: 'yingjie', graduationClass: 2027, graduationMonth: 6 });
    expect(v.effects!.cnFields).toMatchObject({ identity: 'yingjie', graduationClass: 2027, graduationMonth: 6, yearsExperience: null });
    expect(v.effects!.filterPatch).toEqual({ classYear: 2027 });
  });

  it('社招 needs years and 求职状态; 届别 is cleared', async () => {
    expect(issuesOf(await validateCnStep('identity', { cnIdentity: 'shezhao' }))).toEqual(['yearsExperience:required', 'jobSearchStatus:required']);
    const v = ok(await validateCnStep('identity', { cnIdentity: 'shezhao', yearsExperience: '3-5', jobSearchStatus: 'employed_open', graduationClass: 2027 }));
    expect(v.answers).toEqual({ cnIdentity: 'shezhao', yearsExperience: '3-5', jobSearchStatus: 'employed_open' });
    expect(v.effects!.cnFields).toMatchObject({ graduationClass: null, graduationMonth: null });
    expect(v.effects!.filterPatch).toEqual({ classYear: null });
  });

  it('refuses an unknown identity', async () => {
    expect((await validateCnStep('identity', { cnIdentity: 'astronaut' })).ok).toBe(false);
  });
});

// ── G3 education ──────────────────────────────────────────────────────────

describe('G3 教育背景', () => {
  it('应届/在校 need 学历 and a school, and cannot skip; 社招 can skip', async () => {
    const ctx = { answers: answersFor('yingjie') };
    expect(issuesOf(await validateCnStep('education', {}, ctx))).toEqual(['degree:required', 'school:required']);
    expect(issuesOf(await validateCnStep('education', { skip: true }, ctx))).toEqual(['skip:skip_not_allowed']);
    const skipped = ok(await validateCnStep('education', { skip: true }, { answers: answersFor('shezhao') }));
    expect(skipped.answers).toEqual({ skip: true });
    expect(skipped.effects).toEqual({ consents: [], cnFields: null, filterPatch: null });
  });

  it('a listed school carries its official marks; no filter is set', async () => {
    const v = ok(await validateCnStep('education', { degree: 'bachelor', fullTime: true, school: '浙江大学', major: ' 计算机科学 ' }, { answers: answersFor('yingjie') }));
    expect(v.answers).toEqual({ degree: 'bachelor', fullTime: true, school: '浙江大学', schoolId: '浙江大学', major: '计算机科学', overseas: false });
    expect(v.effects!.cnFields).toMatchObject({ schoolTags: ['985', '211', 'double_first_class'], isFullTimeProgram: true, overseasSchool: false });
    expect(v.effects!.filterPatch).toBeNull();
  });

  it('统招 is never assumed: unanswered stores no answer and clears the profile field; yes and no are stored as given', async () => {
    const ctx = { answers: answersFor('yingjie') };
    const unanswered = ok(await validateCnStep('education', { degree: 'bachelor', school: '浙江大学' }, ctx));
    expect(unanswered.answers).not.toHaveProperty('fullTime');
    expect(unanswered.effects!.cnFields).toHaveProperty('isFullTimeProgram', null);
    const no = ok(await validateCnStep('education', { degree: 'bachelor', school: '浙江大学', fullTime: false }, ctx));
    expect(no.answers).toMatchObject({ fullTime: false });
    expect(no.effects!.cnFields).toMatchObject({ isFullTimeProgram: false });
    const yes = ok(await validateCnStep('education', { degree: 'bachelor', school: '浙江大学', fullTime: true }, ctx));
    expect(yes.effects!.cnFields).toMatchObject({ isFullTimeProgram: true });
  });

  it('an unlisted or overseas school carries no marks (free text allowed)', async () => {
    const unlisted = ok(await validateCnStep('education', { degree: 'dazhuan', school: '某某职业技术学院' }, { answers: answersFor('zaixiao') }));
    expect(unlisted.effects!.cnFields).toMatchObject({ schoolName: '某某职业技术学院', schoolId: null, schoolTags: [] });
    const overseas = ok(await validateCnStep('education', { degree: 'master', school: '清华大学', schoolId: '清华大学', overseas: true }, { answers: answersFor('yingjie') }));
    expect(overseas.effects!.cnFields).toMatchObject({ schoolTags: [], schoolId: null, overseasSchool: true });
  });
});

// ── G4 intent ─────────────────────────────────────────────────────────────

describe('G4 求职期望', () => {
  const base = { targetRoles: [{ label: '产品经理', taxonomyId: 'product_manager' }], cities: ['上海', '杭州'], workType: 'full_time' };

  it('salary min ≤ max and on the option grid; ·N薪 12–20', async () => {
    expect((await validateCnStep('intent', { ...base, salaryMonthlyK: { min: 25, max: 15 } })).ok).toBe(false);
    expect(issuesOf(await validateCnStep('intent', { ...base, salaryMonthlyK: { min: 15, max: 32 } }))).toEqual(['salaryMonthlyK.max:not_an_option']);
    expect((await validateCnStep('intent', { ...base, salaryMonthlyK: { min: 15, max: 25 }, salaryMonths: 21 })).ok).toBe(false);
    ok(await validateCnStep('intent', { ...base, salaryMonthlyK: { min: 15, max: 25 }, salaryMonths: 13 }));
    ok(await validateCnStep('intent', { ...base, salaryMonthlyK: 'negotiable' }));
  });

  it('roles 1–3, cities ≤5, 不限 alone, industries ≤3 from GB/T 4754', async () => {
    expect((await validateCnStep('intent', { ...base, targetRoles: [] })).ok).toBe(false);
    expect((await validateCnStep('intent', { ...base, targetRoles: [1, 2, 3, 4].map((i) => ({ label: `职位${i}` })) })).ok).toBe(false);
    expect((await validateCnStep('intent', { ...base, cities: ['北京', '上海', '广州', '深圳', '杭州', '成都'] })).ok).toBe(false);
    expect(issuesOf(await validateCnStep('intent', { ...base, cities: ['any', '上海'] }))).toEqual(['cities:any_with_others']);
    expect(issuesOf(await validateCnStep('intent', { ...base, industries: ['I', 'Z'] }))).toEqual(['industries.1:not_an_option']);
    expect((await validateCnStep('intent', { ...base, industries: ['I', 'J', 'C', 'P'] })).ok).toBe(false);
  });

  it('maps a full-time 应届 intent to the default search profile', async () => {
    const v = ok(
      await validateCnStep(
        'intent',
        { ...base, industries: ['I'], salaryMonthlyK: { min: 15, max: 25 }, salaryMonths: 14, acceptReassignment: true },
        { answers: answersFor('yingjie') },
      ),
    );
    expect(v.effects!.filterPatch).toEqual({
      taxonomyIds: ['product_manager'],
      titles: ['产品经理'],
      country: 'CN',
      locations: [
        { label: '上海', city: '上海', country: 'CN', radiusKm: 0 },
        { label: '杭州', city: '杭州', region: '浙江', country: 'CN', radiusKm: 0 },
      ],
      industries: ['信息传输、软件和信息技术服务业'],
      jobTypes: ['full_time'],
      employmentType: ['campus'],
      salaryMin: { amount: 15000, currency: 'CNY', period: 'month' },
      dailyPay: null,
      internDays: null,
    });
    expect(v.answers).toMatchObject({ salaryMonths: 14, acceptReassignment: true, startDate: 'anytime' });
    expect(v.effects!.cnFields).toMatchObject({ availableFrom: 'anytime', acceptReassignment: true, internshipDaysPerWeek: null });
  });

  it('实习 gets days/week (default 4) and months (default 3个月); 元/天 on the grid; monthly pay dropped', async () => {
    const intern = { ...base, workType: 'internship', salaryMonthlyK: { min: 5, max: 8 } };
    const v = ok(await validateCnStep('intent', intern, { answers: answersFor('zaixiao') }));
    expect(v.answers).toMatchObject({ internDaysPerWeek: 4, internMonths: '3', internDailyPay: 'any' });
    expect(v.answers).not.toHaveProperty('salaryMonthlyK');
    expect(v.effects!.filterPatch).toMatchObject({ employmentType: ['internship'], jobTypes: ['internship'], internDays: { max: 4 }, salaryMin: null, dailyPay: null });
    expect(issuesOf(await validateCnStep('intent', { ...intern, internDailyPay: { min: 125, max: 300 } }))).toEqual(['internDailyPay.min:not_an_option']);
    const paid = ok(await validateCnStep('intent', { ...intern, internDailyPay: { min: 200, max: 300 }, internDaysPerWeek: 3 }));
    expect(paid.effects!.filterPatch).toMatchObject({ dailyPay: { min: 200 }, internDays: { max: 3 } });
  });

  it('指定日期 needs a real date; 社招 has no 接受调剂; 不限 clears locations', async () => {
    expect(issuesOf(await validateCnStep('intent', { ...base, startDate: 'date', startDateValue: '2026-02-30' }))).toEqual(['startDateValue:invalid_date']);
    const dated = ok(await validateCnStep('intent', { ...base, startDate: 'date', startDateValue: '2026-11-01' }));
    expect(dated.effects!.cnFields).toMatchObject({ availableFrom: '2026-11-01' });
    const social = ok(await validateCnStep('intent', { ...base, cities: ['any'], acceptReassignment: true }, { answers: answersFor('shezhao') }));
    expect(social.answers).not.toHaveProperty('acceptReassignment');
    expect(social.effects!.filterPatch).toMatchObject({ locations: null, employmentType: ['social'] });
  });
});

// ── G5 tags, G7 confirm, unknown steps ────────────────────────────────────

describe('G5 更看重什么 and G7 确认', () => {
  it('都可以 is the default and stands alone; tags never hide jobs', async () => {
    const v = ok(await validateCnStep('tags', {}));
    expect(v.answers).toEqual({ employerTypes: ['any'], wantsHukou: false });
    expect(issuesOf(await validateCnStep('tags', { employerTypes: ['any', 'soe'] }))).toEqual(['employerTypes:any_with_others']);
    const picked = ok(await validateCnStep('tags', { employerTypes: ['soe', 'startup'], wantsHukou: true }));
    expect(picked.effects).toEqual({ consents: [], cnFields: null, filterPatch: null });
    expect(ok(await validateCnStep('tags', { skip: true })).answers).toEqual({ skip: true });
  });

  it('confirm merges extra roles into the search and keeps the optional source', async () => {
    const answers = { ...answersFor('yingjie'), intent: { targetRoles: [{ label: '产品经理', taxonomyId: 'product_manager' }] } };
    const v = ok(await validateCnStep('confirm', { extraRoles: [{ label: '运营' }, { label: '产品经理' }], heardFrom: 'xiaohongshu' }, { answers }));
    expect(v.effects!.filterPatch).toEqual({ taxonomyIds: ['product_manager'], titles: ['产品经理', '运营'] });
    expect(v.answers).toEqual({ extraRoles: [{ label: '运营' }, { label: '产品经理' }], heardFrom: 'xiaohongshu' });
    expect(ok(await validateCnStep('confirm', {})).effects!.filterPatch).toBeNull();
  });

  it('a re-save without the extra roles sets the search back to the G4 roles', async () => {
    const answers = { ...answersFor('yingjie'), intent: { targetRoles: [{ label: '产品经理', taxonomyId: 'product_manager' }] }, confirm: { extraRoles: [{ label: '运营' }] } };
    const v = ok(await validateCnStep('confirm', { heardFrom: 'school' }, { answers }));
    expect(v.effects!.filterPatch).toEqual({ taxonomyIds: ['product_manager'], titles: ['产品经理'] });
    expect(v.answers).toEqual({ heardFrom: 'school' });
  });

  it('shared or unknown stages are not validated here', async () => {
    for (const step of ['resume', 'matching', 'situation', 'nope']) {
      expect(issuesOf(await validateCnStep(step, {}))).toEqual([':unknown_step']);
    }
  });
});

// ── First value (R-14) ────────────────────────────────────────────────────

describe('first-value routing', () => {
  it('/campus → /jobs → /resume; 社招 → /jobs', () => {
    const all = { campusCalendar: true, jobsFeed: true };
    expect(firstValueRoute('goapply', cnFirstValueContext(answersFor('yingjie'), all))).toBe('/campus');
    expect(firstValueRoute('goapply', cnFirstValueContext(answersFor('shezhao'), all))).toBe('/jobs');
    expect(firstValueRoute('goapply', cnFirstValueContext(answersFor('yingjie'), { campusCalendar: false, jobsFeed: true }))).toBe('/jobs');
    expect(firstValueRoute('goapply', cnFirstValueContext(answersFor('shezhao'), { campusCalendar: true, jobsFeed: false }))).toBe('/campus');
    expect(firstValueRoute('goapply', cnFirstValueContext(null, { campusCalendar: false, jobsFeed: false }))).toBe('/resume');
  });

  it('the context carries the 届别 of 应届 / 在校 users (the campus calendar opens on it); 社招 has none', () => {
    const all = { campusCalendar: true, jobsFeed: true };
    expect(cnFirstValueContext({ identity: { cnIdentity: 'yingjie', graduationClass: 2027 } }, all).cnClassYear).toBe(2027);
    expect(cnFirstValueContext({ identity: { cnIdentity: 'zaixiao', graduationClass: 2028 } }, all).cnClassYear).toBe(2028);
    expect(cnFirstValueContext({ identity: { cnIdentity: 'shezhao', graduationClass: 2027 } }, all).cnClassYear).toBeNull();
    expect(cnFirstValueContext(null, all).cnClassYear).toBeNull();
  });
});

// ── 个性化推荐 feed seam (PIPL Art. 24) ───────────────────────────────────

describe('personalised recommendation seam', () => {
  it('off or unchosen ⇒ non-personalised order (newest), RoboApply always personalised', () => {
    expect(rankingModeFor('goapply', null)).toBe('non_personalized');
    expect(rankingModeFor('goapply', false)).toBe('non_personalized');
    expect(rankingModeFor('goapply', true)).toBe('personalized');
    expect(rankingModeFor('roboapply', null)).toBe('personalized');
    expect(feedSortFor('recommended', 'non_personalized')).toBe('newest');
    expect(feedSortFor('best_fit', 'non_personalized')).toBe('newest');
    expect(feedSortFor('deadline', 'non_personalized')).toBe('deadline');
    expect(feedSortFor('recommended', 'personalized')).toBe('recommended');
  });

  it('reads the latest consent record (the G1 choice, changeable in Settings)', async () => {
    const fake = createFakePrisma({ seed: { seekerProfile: [{ id: 'sp1', userId: 'u1' }] } });
    const db = fake as never;
    expect(await rankingModeForUser('u1', 'goapply', db)).toBe('non_personalized');
    fake.$rows('seekerConsentRecord').push(
      { seekerProfileId: 'sp1', consentType: 'personalized_recommendation', granted: true, createdAt: new Date('2026-10-01') },
      { seekerProfileId: 'sp1', consentType: 'personalized_recommendation', granted: false, createdAt: new Date('2026-10-05') },
    );
    expect(await rankingModeForUser('u1', 'goapply', db)).toBe('non_personalized');
    fake.$rows('seekerConsentRecord').push({ seekerProfileId: 'sp1', consentType: 'personalized_recommendation', granted: true, createdAt: new Date('2026-10-09') });
    expect(await rankingModeForUser('u1', 'goapply', db)).toBe('personalized');
    expect(await rankingModeForUser('nobody', 'roboapply', db)).toBe('personalized');
  });

  it('the service routes the same answer', async () => {
    const fake = createFakePrisma({
      seed: {
        seekerProfile: [{ id: 'sp1', userId: 'u1' }],
        seekerConsentRecord: [{ seekerProfileId: 'sp1', consentType: 'personalized_recommendation', granted: false, createdAt: new Date() }],
      },
    });
    const svc = createOnboardingCnService({ consentDb: fake as never });
    expect(await svc.rankingMode('u1', 'goapply')).toBe('non_personalized');
  });

  // Non-personalised order in the feed itself (GET /feed for a GoApply user
  // with no personalized_recommendation record lists newest first with fit =
  // null on every item) is the feed's rule, `isFeedPersonalized`, and is
  // tested where it lives: server/src/features/feed/personalization.cn.test.ts.
  // The duplicate `feedRankingFor` that used to sit here is gone.
  it('this area no longer exports a second feed-ranking rule', async () => {
    const surface = await import('./index.js');
    expect(Object.keys(surface)).not.toContain('feedRankingFor');
    expect(Object.keys(await import('./personalization.js')).sort()).toEqual(['feedSortFor', 'personalizedChoice', 'rankingModeFor', 'rankingModeForUser']);
  });
});

// ── applyCnStep (manual mode, zero LLM calls) ─────────────────────────────

describe('applyCnStep', () => {
  function deps() {
    return {
      recordConsent: vi.fn(async () => ({})),
      patchCnFields: vi.fn(async () => ({})),
      patchDefaultFilters: vi.fn(async () => ({})),
    };
  }

  it('records each consent with the prose version shown, and nothing else, with AI consent off', async () => {
    llm.calls = 0;
    const d = deps();
    const v = ok(await validateCnStep('consent', consentBody(), { env: OFFSHORE }));
    const res = await applyCnStep('u1', GO, v, { locale: 'zh' }, d);
    expect(res).toEqual({ consentsRecorded: 6, consentsAlreadyGiven: 0, cnFieldsWritten: false, filtersWritten: false });
    expect(d.recordConsent).toHaveBeenCalledWith({ userId: 'u1', brand: GO, type: 'ai_resume_parsing', granted: false, proseVersion: CONSENT_PROSE_VERSION, locale: 'zh' });
    expect(d.patchCnFields).not.toHaveBeenCalled();
    expect(llm.calls).toBe(0);
  });

  it('the three required consents given at sign-up are not recorded a second time; the optional choices always are', async () => {
    const d = { ...deps(), grantedConsents: vi.fn(async () => new Set(['pipl_basic_processing', 'age_16_plus', 'pipl_cross_border', 'marketing_email'])) };
    const v = ok(await validateCnStep('consent', consentBody(), { env: OFFSHORE }));
    const res = await applyCnStep('u1', GO, v, { locale: 'zh' }, d);
    expect(d.grantedConsents).toHaveBeenCalledWith('u1', GO);
    expect(res).toMatchObject({ consentsRecorded: 3, consentsAlreadyGiven: 3 });
    // G1 put only the optional choices to the user, so only those get a record with G1's prose hash.
    expect(d.recordConsent.mock.calls.map((c) => (c as unknown as [{ type: string }])[0].type)).toEqual(['ai_resume_parsing', 'personalized_recommendation', 'marketing_email']);
  });

  it('a grant of an earlier text does not count as given: G1 asks again and the answer is recorded under the current text', async () => {
    const ledger = [
      { type: 'pipl_basic_processing', granted: true, answeredTextCurrent: true },
      { type: 'age_16_plus', granted: true }, // a reader that does not say: treated as before
      { type: 'pipl_cross_border', granted: true, answeredTextCurrent: false },
      { type: 'marketing_email', granted: false, answeredTextCurrent: true },
    ];
    expect([...consentsGivenToCurrentText(ledger)]).toEqual(['pipl_basic_processing', 'age_16_plus']);
    const d = { ...deps(), grantedConsents: vi.fn(async () => consentsGivenToCurrentText(ledger)) };
    const v = ok(await validateCnStep('consent', consentBody(), { env: OFFSHORE }));
    const res = await applyCnStep('u1', GO, v, { locale: 'zh' }, d);
    expect(res).toMatchObject({ consentsRecorded: 4, consentsAlreadyGiven: 2 });
    expect(d.recordConsent).toHaveBeenCalledWith({ userId: 'u1', brand: GO, type: 'pipl_cross_border', granted: true, proseVersion: CONSENT_PROSE_VERSION, locale: 'zh' });
  });

  it('a required consent the ledger does not hold is still recorded (email sign-up, or a ledger that could not be read)', async () => {
    const d = { ...deps(), grantedConsents: vi.fn(async () => new Set(['pipl_basic_processing'])) };
    const v = ok(await validateCnStep('consent', consentBody(), { env: OFFSHORE }));
    const res = await applyCnStep('u1', GO, v, { locale: 'zh' }, d);
    expect(res).toMatchObject({ consentsRecorded: 5, consentsAlreadyGiven: 1 });
    expect(d.recordConsent.mock.calls.map((c) => (c as unknown as [{ type: string }])[0].type)).toEqual([
      'age_16_plus',
      'pipl_cross_border',
      'ai_resume_parsing',
      'personalized_recommendation',
      'marketing_email',
    ]);
  });

  it('manual mode end to end: every step saves with zero LLM calls and no parse', async () => {
    llm.calls = 0;
    const d = deps();
    const answers: Record<string, unknown> = {};
    const steps: Array<[string, unknown]> = [
      ['consent', consentBody()],
      ['identity', { cnIdentity: 'yingjie', graduationClass: 2027 }],
      ['education', { degree: 'bachelor', school: '南京大学' }],
      ['intent', { targetRoles: [{ label: '数据分析' }], cities: ['南京'], workType: 'full_time' }],
      ['tags', { skip: true }],
      ['confirm', { heardFrom: 'school' }],
    ];
    for (const [step, body] of steps) {
      const v = ok(await validateCnStep(step, body, { env: OFFSHORE, answers }));
      answers[step] = v.answers;
      await applyCnStep('u1', GO, v, {}, d);
    }
    expect(d.patchCnFields).toHaveBeenCalledTimes(3);
    // identity (届别), intent and confirm (roles reset to G4's + extras).
    expect(d.patchDefaultFilters).toHaveBeenCalledTimes(3);
    expect(llm.calls).toBe(0);
  });

  it('writes nothing for a failed validation', async () => {
    const d = deps();
    const res = await applyCnStep('u1', GO, { ok: false, issues: [] }, {}, d);
    expect(res).toEqual({ consentsRecorded: 0, consentsAlreadyGiven: 0, cnFieldsWritten: false, filtersWritten: false });
    expect(d.recordConsent).not.toHaveBeenCalled();
  });
});

// ── School marks never reach ranking (WP-18 preScore) ─────────────────────

describe('school tier is never a ranking input', () => {
  it('two users who differ only in school get identical pre-scores', async () => {
    const answers = answersFor('yingjie');
    const elite = ok(await validateCnStep('education', { degree: 'bachelor', school: '北京大学' }, { answers }));
    const other = ok(await validateCnStep('education', { degree: 'bachelor', school: '某某学院' }, { answers }));
    expect(elite.effects!.cnFields!.schoolTags).toEqual(['985', '211', 'double_first_class']);
    expect(other.effects!.cnFields!.schoolTags).toEqual([]);
    const intent = ok(await validateCnStep('intent', { targetRoles: [{ label: '软件工程师', taxonomyId: 'software_engineer' }], cities: ['北京'], workType: 'full_time' }, { answers }));
    const user = (cnFields: Record<string, unknown>) =>
      buildMatchUser({
        userId: 'u',
        market: 'cn',
        profile: { firstName: null, lastName: null, country: 'CN', skills: [{ name: 'Python' }], workAuth: [], cnFields: { identity: 'yingjie', graduationClass: 2027, ...cnFields } },
        education: [{ degree: '本科', endYm: '2027-06' }],
        experience: [],
        resumeParsed: null,
        searchProfile: { filters: intent.effects!.filterPatch, version: 1 },
        employerIndustries: [],
      });
    const job: MatchJobRecord = {
      id: 'j1', market: 'cn', visibility: 'public', ownerUserId: null, title: '软件工程师（2027届校招）', companyName: '某公司',
      description: '要求：985/211 院校优先，熟悉 Python', descriptionPlain: '要求：985/211 院校优先，熟悉 Python', qualifications: null, responsibilities: null, benefits: null,
      taxonomyIds: ['software_engineer'], primaryTaxonomyId: 'software_engineer', seniority: 'intern_newgrad', minYears: null, maxYears: null, educationLevel: 'bachelor',
      skills: ['python'], skillsDetail: null, workModel: 'onsite', remoteScope: null, location: '北京', locationCity: '北京', locationCountry: 'CN', geoLat: null, geoLng: null,
      salaryAnnualMin: null, salaryAnnualMax: null, salaryCurrency: 'CNY', sponsorship: null, sponsorshipEvidence: null, marketTags: null, archivedAt: null, companyIndustries: [],
    };
    const config = { weights: getMatchWeights({}), tiers: getMatchTiers({}) };
    const a = preScore(user(elite.effects!.cnFields!), toMatchJob(job), config);
    const b = preScore(user(other.effects!.cnFields!), toMatchJob(job), config);
    expect(a).toEqual(b);
  });
});

// ── Market snapshot (D3) ──────────────────────────────────────────────────

describe('cn market snapshot', () => {
  const NOW = new Date('2026-10-10T00:00:00Z');
  // `Prisma.DbNull` stands for a SQL NULL fraudFlags column in the fake.
  const live = { market: 'cn', visibility: 'public', isCanonical: true, archivedAt: null, closedAt: null, fraudFlags: Prisma.DbNull, lastSeenAt: new Date('2026-10-08T00:00:00Z') };
  const job = (i: number, over: Record<string, unknown> = {}) => ({
    id: `j${i}`, title: '产品经理', location: '上海', locationCity: '上海', salaryDisclosed: false, salaryCurrency: null, salaryPeriod: null, salaryMin: null, salaryMax: null, ...live, ...over,
  });
  const paid = (i: number, min: number, max: number) => job(i, { salaryDisclosed: true, salaryCurrency: 'CNY', salaryPeriod: 'month', salaryMin: min, salaryMax: max });

  it('counts only public canonical live cn rows (a private imported job never counts) and suppresses pay below 20 rows', async () => {
    const fake = createFakePrisma({
      seed: {
        rAJob: [
          ...Array.from({ length: MIN_SAMPLE - 1 }, (_, i) => paid(i, 15000, 25000)),
          job(100),
          job(101, { visibility: 'private', ownerUserId: 'u1', salaryDisclosed: true, salaryCurrency: 'CNY', salaryPeriod: 'month', salaryMin: 90000, salaryMax: 90000 }),
          job(102, { market: 'intl' }),
          job(103, { isCanonical: false }),
          job(104, { archivedAt: new Date('2026-10-01') }),
          job(105, { lastSeenAt: new Date('2026-08-01') }),
          job(106, { title: '会计', locationCity: '北京', location: '北京' }),
          job(107, { fraudFlags: [{ rule: 'deposit_required', evidence: '需缴纳押金', at: '2026-10-01T00:00:00Z' }], salaryDisclosed: true, salaryCurrency: 'CNY', salaryPeriod: 'month', salaryMin: 80000, salaryMax: 90000 }),
        ],
        rACampusEvent: [
          { market: 'cn', status: 'published', graduationClass: '2027届', applyOpensAt: new Date('2026-09-01'), applyClosesAt: new Date('2026-10-31'), cities: [] },
          { market: 'cn', status: 'draft', graduationClass: '2027届', applyOpensAt: null, applyClosesAt: new Date('2026-10-31'), cities: [] },
          { market: 'cn', status: 'published', graduationClass: '2027届', applyOpensAt: null, applyClosesAt: new Date('2026-10-01'), cities: [] },
          { market: 'cn', status: 'published', graduationClass: '2028届', applyOpensAt: null, applyClosesAt: new Date('2026-12-01'), cities: [] },
        ],
      },
    });
    const snap = await cnMarketSnapshot({ roles: ['产品经理'], cities: ['上海'], class: 2027 }, { db: fake as never, now: NOW });
    expect(snap.jobCount).toEqual({ value: MIN_SAMPLE, source: 'index', asOf: NOW.toISOString() });
    expect(snap.pay).toBeNull();
    // Campus: published, window open now, this 届别 (the fake has no array operators, so no city here).
    const campus = await cnMarketSnapshot({ class: 2027 }, { db: fake as never, now: NOW });
    expect(campus.campusOpenCount).toEqual({ value: 1, source: 'campus_calendar', asOf: NOW.toISOString() });
  });

  it('shows the median and N once 20 postings list monthly CNY pay', async () => {
    const rows = Array.from({ length: MIN_SAMPLE }, (_, i) => paid(i, 10000 + i * 1000, 20000 + i * 1000));
    const fake = createFakePrisma({ seed: { rAJob: [...rows, job(200), job(201)], rACampusEvent: [] } });
    const snap = await cnMarketSnapshot({ roles: ['产品经理'] }, { db: fake as never, now: NOW });
    expect(snap.jobCount.value).toBe(MIN_SAMPLE + 2);
    expect(snap.pay).toMatchObject({ listedCount: MIN_SAMPLE, sampleSize: MIN_SAMPLE, currency: 'CNY', period: 'month', source: 'index', medianMonthly: 24500 });
    const std = toOnboardingSnapshot(snap);
    expect(std.pay).toMatchObject({ listedCount: MIN_SAMPLE, currency: 'CNY', period: 'month', low: snap.pay!.p25Monthly, high: snap.pay!.p75Monthly });
    expect(std.topSkills).toEqual([]);
  });

  it('builds the D3 predicate for the database', () => {
    const where = cnJobWhere({ taxonomyIds: ['pm'], roles: ['产品'], cities: ['any'] }, NOW);
    expect(where).toMatchObject({ market: 'cn', visibility: 'public', isCanonical: true, archivedAt: null, closedAt: null });
    expect(JSON.stringify(where)).toContain('hasSome');
    expect(JSON.stringify(where)).not.toContain('locationCity'); // 不限 = no city filter
    expect(where.AND).toContainEqual(NOT_FRAUD_FLAGGED); // R-17: flagged postings never count
    const campusWhere = cnCampusWhere({ cities: ['上海'], class: 2028 }, NOW);
    expect(campusWhere).toMatchObject({ status: 'published', graduationClass: '2028届' });
    expect(JSON.stringify(campusWhere.AND)).toContain('"hasSome":["上海"]');
  });
});
