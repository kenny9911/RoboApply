// components/features/onboarding-cn/logic.ts — client twin of the GoApply step rules (WP-31).
//
// Mirrors of server/src/features/onboarding-cn/{contract,classYear,salary}.ts
// (option lists, 届别 defaults, the K/月·N薪 display form). The server is the
// authority — it re-validates every step — and __tests__/onboardingCn.test.tsx
// keeps these mirrors equal to the server values.

import type { CnStepContext } from '../../../lib/api/contracts/onboarding-cn';

export const CN_IDENTITIES = ['yingjie', 'zaixiao', 'shezhao'] as const;
export type CnIdentity = (typeof CN_IDENTITIES)[number];
export const CN_YEARS_EXPERIENCE = ['lt1', '1-3', '3-5', '5-10', '10+'] as const;
export const CN_JOB_SEARCH_STATUS = ['left_available', 'employed_within_month', 'employed_open', 'employed_not_looking'] as const;
export const CN_DEGREE_OPTIONS = ['dazhuan', 'bachelor', 'master', 'phd', 'other'] as const;
export const CN_WORK_TYPES = ['full_time', 'internship', 'part_time'] as const;
export type CnWorkType = (typeof CN_WORK_TYPES)[number];
export const CN_INTERN_MONTHS = ['1-2', '3', '6+'] as const;
export const CN_START_DATES = ['anytime', 'within_month', 'date'] as const;
export const CN_EMPLOYER_TYPES = ['soe', 'foreign', 'big_private', 'startup', 'public_institution', 'any'] as const;
export const CN_HEARD_FROM = ['xiaohongshu', 'douyin', 'wechat', 'zhihu', 'bilibili', 'friend', 'school', 'other'] as const;
export const CN_INDUSTRY_CODES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T'] as const;
export const CN_CLASS_YEAR_RANGE = { min: 2025, max: 2030 } as const;
export const CN_SALARY_K_OPTIONS: readonly number[] = [
  ...Array.from({ length: 30 }, (_, i) => i + 1),
  ...Array.from({ length: 14 }, (_, i) => 35 + i * 5),
];
export const CN_SALARY_MONTHS_OPTIONS: readonly number[] = Array.from({ length: 9 }, (_, i) => 12 + i);
export const CN_INTERN_DAILY_OPTIONS: readonly number[] = Array.from({ length: 19 }, (_, i) => 100 + i * 50);
export const CN_INTERN_DAYS_OPTIONS = [2, 3, 4, 5] as const;
export const CN_MAX_ROLES = 3;
export const CN_MAX_CITIES = 5;
export const CN_MAX_INDUSTRIES = 3;
export const CN_ANY_CITY = 'any';
export const CN_DEFAULT_GRADUATION_MONTH = 6;
export const CAMPUS_SEASON_ROLLOVER_MONTH = 7;

const CST_OFFSET_MS = 8 * 60 * 60 * 1000;

/** The 应届 class being hired now (China time; from July it is next year's class). */
export function currentCampusClass(now: Date = new Date()): number {
  const shifted = new Date(now.getTime() + CST_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  return shifted.getUTCMonth() + 1 >= CAMPUS_SEASON_ROLLOVER_MONTH ? year + 1 : year;
}

/** Default 届别: 应届 = the current class; 在校 = the class after it; clamped to 2025–2030. */
export function defaultGraduationClass(identity: 'yingjie' | 'zaixiao', now: Date = new Date()): number {
  const y = currentCampusClass(now) + (identity === 'zaixiao' ? 1 : 0);
  return Math.min(CN_CLASS_YEAR_RANGE.max, Math.max(CN_CLASS_YEAR_RANGE.min, y));
}

export function classYearOptions(): number[] {
  const out: number[] = [];
  for (let y = CN_CLASS_YEAR_RANGE.min; y <= CN_CLASS_YEAR_RANGE.max; y++) out.push(y);
  return out;
}

/** "15-25K·13薪" / "20K" (the negotiable word comes from the bundle). */
export function formatMonthlyK(range: { min: number; max: number }, months?: number | null): string {
  const r = range.min === range.max ? `${range.min}K` : `${range.min}-${range.max}K`;
  return months ? `${r}·${months}薪` : r;
}

/** Monthly yuan → "18.5K" (one decimal at most). */
export function yuanToK(yuan: number): string {
  return `${Math.round(yuan / 100) / 10}K`;
}

export const isStudent = (id: CnIdentity | null | undefined): id is 'yingjie' | 'zaixiao' => id === 'yingjie' || id === 'zaixiao';

type Answers = NonNullable<CnStepContext['answers']>;
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** One stored step's answers, as a record (empty when absent). */
export function stepAnswers(answers: Answers | null | undefined, step: string): Record<string, unknown> {
  const v = isRecord(answers) ? answers[step] : null;
  return isRecord(v) ? v : {};
}

export function identityOf(answers: Answers | null | undefined): CnIdentity | null {
  const id = stepAnswers(answers, 'identity').cnIdentity;
  return (CN_IDENTITIES as readonly string[]).includes(id as string) ? (id as CnIdentity) : null;
}

/** Toggle a value in a multi-select with a cap and an exclusive "any" value. */
export function toggleMulti<T extends string>(list: readonly T[], value: T, opts: { max: number; exclusive?: T }): T[] {
  if (list.includes(value)) return list.filter((v) => v !== value);
  if (opts.exclusive !== undefined) {
    if (value === opts.exclusive) return [value];
    const rest = list.filter((v) => v !== opts.exclusive);
    return rest.length >= opts.max ? rest : [...rest, value];
  }
  return list.length >= opts.max ? [...list] : [...list, value];
}

/** Server issue codes the steps translate (anything else reads as a generic save error). */
export const ISSUE_CODES = ['required', 'not_an_option', 'any_with_others', 'invalid_date', 'skip_not_allowed', 'onboarding_cn_prose_outdated'] as const;
