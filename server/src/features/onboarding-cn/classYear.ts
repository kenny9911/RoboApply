// server/src/features/onboarding-cn/classYear.ts — 届别 defaults (PRODUCT_PLAN.md §4.5 G2).
//
// The campus class is the year the student graduates. Autumn campus hiring
// (秋招) for a class opens in the summer before its final year, so from July
// onward the "current" 应届 class is next year's: in October 2026 应届 means
// 2027届 and 在校 (the class after) 2028届. Dates are read in China Standard
// Time (UTC+8, no daylight saving). Pure; mirrored on the client by
// components/features/onboarding-cn/logic.ts (parity test).

import { CN_CLASS_YEAR_RANGE } from './contract.js';

/** The month (1–12) the campus season rolls over to next year's class. */
export const CAMPUS_SEASON_ROLLOVER_MONTH = 7;
/** Default 毕业月份 (PRODUCT G2). */
export const CN_DEFAULT_GRADUATION_MONTH = 6;

const CST_OFFSET_MS = 8 * 60 * 60 * 1000;

function cstYearMonth(now: Date): { year: number; month: number } {
  const shifted = new Date(now.getTime() + CST_OFFSET_MS);
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1 };
}

export function clampClassYear(year: number): number {
  return Math.min(CN_CLASS_YEAR_RANGE.max, Math.max(CN_CLASS_YEAR_RANGE.min, Math.trunc(year)));
}

/** The 应届 class being hired now (Oct 2026 → 2027), unclamped. */
export function currentCampusClass(now: Date = new Date()): number {
  const { year, month } = cstYearMonth(now);
  return month >= CAMPUS_SEASON_ROLLOVER_MONTH ? year + 1 : year;
}

/** Default 届别: 应届 = the current campus class; 在校 = the class after it. Clamped to 2025–2030. */
export function defaultGraduationClass(identity: 'yingjie' | 'zaixiao', now: Date = new Date()): number {
  const current = currentCampusClass(now);
  return clampClassYear(identity === 'zaixiao' ? current + 1 : current);
}

/** The 届别 choices shown (2025届 … 2030届). */
export function classYearOptions(): number[] {
  const out: number[] = [];
  for (let y = CN_CLASS_YEAR_RANGE.min; y <= CN_CLASS_YEAR_RANGE.max; y++) out.push(y);
  return out;
}
