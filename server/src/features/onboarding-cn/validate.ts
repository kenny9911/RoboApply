// server/src/features/onboarding-cn/validate.ts — GoApply step validators (PRODUCT_PLAN.md §4.5 G1–G5, G7).
//
// `validateCnStep(step, body, ctx)` parses a step body with the contract
// schema, applies the cross-field rules the schema alone cannot express, and
// returns the normalized answers plus the effects `applyCnStep` writes
// (consent records, `RAProfile.cnFields` keys, a default search-profile patch).
// Pure: no database, no LLM, no network (manual mode works with AI consent off).
//
// Rules:
//   G1  agreement (+ age 16) required; `pipl_cross_border` required while
//       personal information leaves the mainland on this deployment (the
//       compliance catalog's rule, `crossBorderConsentApplies`: an offshore
//       deployment, or a mainland one that uses the shared stack or a model
//       vendor abroad; GOAPPLY_PARITY_PLAN.md §3.6);
//       个性化推荐 must be an explicit true/false (no default); the prose
//       version must be the one the server serves now.
//   G2  应届/在校 need a 届别 (2025–2030; month defaults to 6); 社招 needs
//       years of experience and 求职状态. Fields of the other path are dropped.
//   G3  应届/在校 need 学历 and a school; only 社招 may skip. A school picked
//       from (or typed exactly as) the MOE list carries its official marks;
//       overseas or unlisted schools carry none. Marks never reach ranking.
//       统招 is stored only when the user answered it: no answer is recorded
//       as neither yes nor no (nothing is assumed about the user).
//   G4  1–3 roles, 1–5 cities (不限 alone), ≤3 industries; pay only on the
//       option grid (K/月 1–30, 35–100; ·N薪 12–20; 实习 100–1000 元/天 step 50);
//       实习 has days/week (default 4) and months (default 3个月); 指定日期
//       needs a date; 接受调剂 only for 应届/在校.
//   G5  都可以 stands alone. Tags are stored as answers only: they label jobs
//       whose official text supports them and never hide jobs.
//   G7  up to 3 extra roles (merged into the search) and an optional source.

import type { z } from 'zod';
import { getBrand } from '../../platform/brand/registry.js';
import { CONSENT_PROSE_VERSION, crossBorderConsentApplies } from '../compliance/index.js';
import {
  CN_ANY_CITY,
  CN_INDUSTRY_CODES,
  CN_INTERN_DAYS_OPTIONS,
  GOAPPLY_STEP_BODY_SCHEMAS,
  isCnStep,
  ONBOARDING_CN_ERROR_CODES,
  type CnConsentEffect,
  type CnStepContext,
  type CnStepEffects,
  type CnStepValidation,
} from './contract.js';
import { CN_DEFAULT_GRADUATION_MONTH } from './classYear.js';
import { findSchool, industryName, provinceOfCity, schoolTagsFor } from './data.js';
import { isInternDailyOption, isSalaryKOption, isSalaryMonthsOption } from './salary.js';

type Issue = { path: (string | number)[]; message: string };
type Identity = 'yingjie' | 'zaixiao' | 'shezhao';

/** Issue messages (codes; the client maps them to copy). */
export const CN_ISSUE = {
  required: 'required',
  notAnOption: 'not_an_option',
  anyWithOthers: 'any_with_others',
  proseOutdated: ONBOARDING_CN_ERROR_CODES.proseOutdated,
  invalidDate: 'invalid_date',
  skipNotAllowed: 'skip_not_allowed',
  unknownStep: 'unknown_step',
} as const;

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The G2 identity stored in earlier answers, if any. */
export function identityFrom(answers: CnStepContext['answers']): Identity | null {
  const id = isRecord(answers) && isRecord(answers.identity) ? answers.identity.cnIdentity : null;
  return id === 'yingjie' || id === 'zaixiao' || id === 'shezhao' ? id : null;
}

const isStudent = (id: Identity | null) => id === 'yingjie' || id === 'zaixiao';

const NO_EFFECTS: CnStepEffects = { consents: [], cnFields: null, filterPatch: null };

function fail(issues: Issue[]): CnStepValidation {
  return { ok: false, issues };
}

function zodIssues(err: z.ZodError): Issue[] {
  return err.issues.map((i) => ({ path: i.path.filter((p): p is string | number => typeof p !== 'symbol'), message: i.message }));
}

function done(answers: Record<string, unknown>, effects: CnStepEffects): CnStepValidation {
  // Drop undefined keys so stored answers stay minimal and stable (idempotent re-saves).
  const clean = Object.fromEntries(Object.entries(answers).filter(([, v]) => v !== undefined));
  return { ok: true, answers: clean, effects };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function isRealDate(v: string): boolean {
  if (!ISO_DATE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

// ── G1 consent ──────────────────────────────────────────────────────────────

function validateConsent(body: unknown, ctx: CnStepContext): CnStepValidation {
  const parsed = GOAPPLY_STEP_BODY_SCHEMAS.consent.safeParse(body);
  if (!parsed.success) return fail(zodIssues(parsed.error));
  const b = parsed.data;
  // One rule with the consent catalog and sign-up (PAR-5 item 7): the box the G1 screen shows
  // (it is catalog-driven) is the box this step requires and stores. For the live process the
  // caller awaits `loadAiStackSnapshot()` first (features/onboarding/defaults.ts).
  const offshore = crossBorderConsentApplies(getBrand('goapply'), ctx.env ?? process.env);
  const issues: Issue[] = [];
  if (offshore && b.crossBorder !== true) issues.push({ path: ['crossBorder'], message: CN_ISSUE.required });
  if (b.proseVersion !== CONSENT_PROSE_VERSION) issues.push({ path: ['proseVersion'], message: CN_ISSUE.proseOutdated });
  if (issues.length) return fail(issues);

  const marketing = b.marketing === true;
  const consents: CnConsentEffect[] = [
    { type: 'pipl_basic_processing', granted: true },
    { type: 'age_16_plus', granted: true },
    ...(offshore ? [{ type: 'pipl_cross_border' as const, granted: true }] : []),
    { type: 'ai_resume_parsing', granted: b.aiProcessing },
    { type: 'personalized_recommendation', granted: b.personalizedRecommendation },
    { type: 'marketing_email', granted: marketing },
  ];
  return done(
    {
      agreement: true,
      crossBorder: offshore ? true : undefined,
      aiProcessing: b.aiProcessing,
      personalizedRecommendation: b.personalizedRecommendation,
      marketing,
      proseVersion: b.proseVersion,
    },
    { consents, cnFields: null, filterPatch: null },
  );
}

// ── G2 identity ─────────────────────────────────────────────────────────────

function validateIdentity(body: unknown): CnStepValidation {
  const parsed = GOAPPLY_STEP_BODY_SCHEMAS.identity.safeParse(body);
  if (!parsed.success) return fail(zodIssues(parsed.error));
  const b = parsed.data;
  if (b.cnIdentity === 'shezhao') {
    const issues: Issue[] = [];
    if (!b.yearsExperience) issues.push({ path: ['yearsExperience'], message: CN_ISSUE.required });
    if (!b.jobSearchStatus) issues.push({ path: ['jobSearchStatus'], message: CN_ISSUE.required });
    if (issues.length) return fail(issues);
    return done(
      { cnIdentity: 'shezhao', yearsExperience: b.yearsExperience, jobSearchStatus: b.jobSearchStatus },
      {
        consents: [],
        cnFields: { identity: 'shezhao', yearsExperience: b.yearsExperience, jobSearchStatus: b.jobSearchStatus, graduationClass: null, graduationMonth: null },
        filterPatch: { classYear: null },
      },
    );
  }
  if (b.graduationClass === undefined) return fail([{ path: ['graduationClass'], message: CN_ISSUE.required }]);
  const month = b.graduationMonth ?? CN_DEFAULT_GRADUATION_MONTH;
  return done(
    { cnIdentity: b.cnIdentity, graduationClass: b.graduationClass, graduationMonth: month },
    {
      consents: [],
      cnFields: { identity: b.cnIdentity, graduationClass: b.graduationClass, graduationMonth: month, yearsExperience: null, jobSearchStatus: null },
      filterPatch: { classYear: b.graduationClass },
    },
  );
}

// ── G3 education ────────────────────────────────────────────────────────────

function validateEducation(body: unknown, ctx: CnStepContext): CnStepValidation {
  const parsed = GOAPPLY_STEP_BODY_SCHEMAS.education.safeParse(body);
  if (!parsed.success) return fail(zodIssues(parsed.error));
  const b = parsed.data;
  const identity = identityFrom(ctx.answers);
  if (b.skip) {
    if (isStudent(identity)) return fail([{ path: ['skip'], message: CN_ISSUE.skipNotAllowed }]);
    return done({ skip: true }, NO_EFFECTS);
  }
  const issues: Issue[] = [];
  if (isStudent(identity)) {
    if (!b.degree) issues.push({ path: ['degree'], message: CN_ISSUE.required });
    if (!b.school) issues.push({ path: ['school'], message: CN_ISSUE.required });
  }
  if (issues.length) return fail(issues);

  const overseas = b.overseas === true;
  // A listed school is matched by id, else by its exact (normalized) name; marks come from the list only.
  const listed = overseas ? null : (b.schoolId ? findSchool(b.schoolId) : null) ?? findSchool(b.school ?? null);
  const schoolName = listed?.name ?? b.school ?? undefined;
  const tags = listed ? schoolTagsFor(listed.id) : [];
  // 统招: the user's own answer, or none. Never defaulted to "yes" (an unanswered question is not a fact about the user).
  const fullTime = typeof b.fullTime === 'boolean' ? b.fullTime : undefined;
  const answers = {
    degree: b.degree,
    fullTime,
    school: schoolName,
    schoolId: listed?.id,
    major: b.major?.trim() ? b.major.trim() : undefined,
    overseas,
  };
  return done(answers, {
    consents: [],
    cnFields: {
      degree: b.degree ?? null,
      // null removes the key (profile `cnFields` PATCH), so an earlier answer the user cleared does not linger.
      isFullTimeProgram: fullTime ?? null,
      schoolName: schoolName ?? null,
      schoolId: listed?.id ?? null,
      schoolTags: tags,
      overseasSchool: overseas,
      major: answers.major ?? null,
    },
    // No filter from education: 学历 filters postings' requirements, and school
    // marks are a filter only when the user turns it on in Filters.
    filterPatch: null,
  });
}

// ── G4 intent ───────────────────────────────────────────────────────────────

const CN_JOB_TYPE: Record<'full_time' | 'internship' | 'part_time', 'full_time' | 'internship' | 'part_time'> = {
  full_time: 'full_time',
  internship: 'internship',
  part_time: 'part_time',
};

function rolesFilter(roles: Array<{ taxonomyId?: string; label: string }>) {
  const seen = new Set<string>();
  const unique = roles.filter((r) => {
    const k = r.label.trim().toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const taxonomyIds = [...new Set(unique.map((r) => r.taxonomyId).filter((x): x is string => !!x))];
  return { roles: unique, taxonomyIds: taxonomyIds.length ? taxonomyIds : null, titles: unique.map((r) => r.label.trim()) };
}

function validateIntent(body: unknown, ctx: CnStepContext): CnStepValidation {
  const parsed = GOAPPLY_STEP_BODY_SCHEMAS.intent.safeParse(body);
  if (!parsed.success) return fail(zodIssues(parsed.error));
  const b = parsed.data;
  const identity = identityFrom(ctx.answers);
  const issues: Issue[] = [];

  const cities = [...new Set(b.cities.map((c) => c.trim()))];
  const anyCity = cities.includes(CN_ANY_CITY);
  if (anyCity && cities.length > 1) issues.push({ path: ['cities'], message: CN_ISSUE.anyWithOthers });

  const industries = [...new Set(b.industries ?? [])];
  industries.forEach((code, i) => {
    if (!(CN_INDUSTRY_CODES as readonly string[]).includes(code)) issues.push({ path: ['industries', i], message: CN_ISSUE.notAnOption });
  });

  const internship = b.workType === 'internship';
  const salary = internship ? undefined : b.salaryMonthlyK;
  if (salary && salary !== 'negotiable') {
    if (!isSalaryKOption(salary.min)) issues.push({ path: ['salaryMonthlyK', 'min'], message: CN_ISSUE.notAnOption });
    if (!isSalaryKOption(salary.max)) issues.push({ path: ['salaryMonthlyK', 'max'], message: CN_ISSUE.notAnOption });
  }
  const salaryMonths = salary && salary !== 'negotiable' ? b.salaryMonths : undefined;
  if (salaryMonths !== undefined && !isSalaryMonthsOption(salaryMonths)) issues.push({ path: ['salaryMonths'], message: CN_ISSUE.notAnOption });

  const daily = internship ? (b.internDailyPay ?? 'any') : undefined;
  if (daily && daily !== 'any') {
    if (!isInternDailyOption(daily.min)) issues.push({ path: ['internDailyPay', 'min'], message: CN_ISSUE.notAnOption });
    if (!isInternDailyOption(daily.max)) issues.push({ path: ['internDailyPay', 'max'], message: CN_ISSUE.notAnOption });
  }
  const days = internship ? (b.internDaysPerWeek ?? 4) : undefined;
  if (days !== undefined && !(CN_INTERN_DAYS_OPTIONS as readonly number[]).includes(days)) issues.push({ path: ['internDaysPerWeek'], message: CN_ISSUE.notAnOption });
  const months = internship ? (b.internMonths ?? '3') : undefined;

  const startDate = b.startDate ?? 'anytime';
  const startDateValue = startDate === 'date' ? b.startDateValue : undefined;
  if (startDate === 'date' && (!startDateValue || !isRealDate(startDateValue))) issues.push({ path: ['startDateValue'], message: CN_ISSUE.invalidDate });

  if (issues.length) return fail(issues);

  const acceptReassignment = isStudent(identity) || identity === null ? b.acceptReassignment ?? false : undefined;
  const { roles, taxonomyIds, titles } = rolesFilter(b.targetRoles);
  const employmentType = internship ? ['internship'] : b.workType === 'full_time' ? (identity === 'shezhao' ? ['social'] : isStudent(identity) ? ['campus'] : null) : null;

  const answers = {
    targetRoles: roles,
    cities,
    industries: industries.length ? industries : undefined,
    workType: b.workType,
    salaryMonthlyK: salary,
    salaryMonths,
    internDailyPay: daily,
    internDaysPerWeek: days,
    internMonths: months,
    startDate,
    startDateValue,
    acceptReassignment,
  };
  return done(answers, {
    consents: [],
    cnFields: {
      internshipDaysPerWeek: days ?? null,
      internshipMonths: months ?? null,
      availableFrom: startDate === 'date' ? startDateValue : startDate,
      acceptReassignment: acceptReassignment ?? null,
    },
    filterPatch: {
      taxonomyIds,
      titles,
      country: 'CN',
      locations: anyCity
        ? null
        : cities.map((city) => {
            const province = provinceOfCity(city);
            return { label: city, city, ...(province && province.name !== city ? { region: province.name } : {}), country: 'CN', radiusKm: 0 };
          }),
      industries: industries.length ? industries.map((c) => industryName(c) ?? c) : null,
      jobTypes: [CN_JOB_TYPE[b.workType]],
      employmentType,
      salaryMin: salary && salary !== 'negotiable' ? { amount: salary.min * 1000, currency: 'CNY', period: 'month' } : null,
      dailyPay: daily && daily !== 'any' ? { min: daily.min } : null,
      // Days a week the user can intern: postings asking for more are filtered out by the feed.
      internDays: days !== undefined ? { max: days } : null,
    },
  });
}

// ── G5 tags ─────────────────────────────────────────────────────────────────

function validateTags(body: unknown): CnStepValidation {
  const parsed = GOAPPLY_STEP_BODY_SCHEMAS.tags.safeParse(body);
  if (!parsed.success) return fail(zodIssues(parsed.error));
  const b = parsed.data;
  if (b.skip) return done({ skip: true }, NO_EFFECTS);
  const types = [...new Set(b.employerTypes ?? ['any'])];
  if (types.includes('any') && types.length > 1) return fail([{ path: ['employerTypes'], message: CN_ISSUE.anyWithOthers }]);
  return done({ employerTypes: types.length ? types : ['any'], wantsHukou: b.wantsHukou === true }, NO_EFFECTS);
}

// ── G7 confirm ──────────────────────────────────────────────────────────────

function validateConfirm(body: unknown, ctx: CnStepContext): CnStepValidation {
  const parsed = GOAPPLY_STEP_BODY_SCHEMAS.confirm.safeParse(body);
  if (!parsed.success) return fail(zodIssues(parsed.error));
  const b = parsed.data;
  const answers = {
    extraRoles: b.extraRoles?.length ? b.extraRoles : undefined,
    heardFrom: b.heardFrom,
    heardFromNote: b.heardFrom === 'other' && b.heardFromNote ? b.heardFromNote : undefined,
  };
  // Always set the roles to exactly the G4 roles plus the extras chosen now,
  // so removing an extra on a re-save removes it from the search too.
  let filterPatch: Record<string, unknown> | null = null;
  const intent = isRecord(ctx.answers) && isRecord(ctx.answers.intent) ? ctx.answers.intent : null;
  const base = Array.isArray(intent?.targetRoles) ? (intent!.targetRoles as Array<{ taxonomyId?: string; label: string }>) : [];
  const all = [...base, ...(b.extraRoles ?? [])];
  if (all.length) {
    const { taxonomyIds, titles } = rolesFilter(all);
    filterPatch = { taxonomyIds, titles };
  }
  return done(answers, { consents: [], cnFields: null, filterPatch });
}

/** Validate one GoApply step body. Unknown steps fail (WP-30 owns the shared stages). */
export function validateCnStep(step: string, body: unknown, ctx: CnStepContext = {}): CnStepValidation {
  if (!isCnStep(step)) return fail([{ path: [], message: CN_ISSUE.unknownStep }]);
  switch (step) {
    case 'consent':
      return validateConsent(body, ctx);
    case 'identity':
      return validateIdentity(body);
    case 'education':
      return validateEducation(body, ctx);
    case 'intent':
      return validateIntent(body, ctx);
    case 'tags':
      return validateTags(body);
    case 'confirm':
      return validateConfirm(body, ctx);
  }
}
