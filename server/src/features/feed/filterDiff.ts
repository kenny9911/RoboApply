// server/src/features/feed/filterDiff.ts — deterministic filter changes (WP-32; ARCH §4.9, PRODUCT F-FEED-10/11/17).
//
//   hideProposal   "Not interested" reason → the exact FilterSet change (or an editor to open)
//   relaxations    one candidate per active filter for "What's limiting your results"
//   planToFilters  the job-search planner's plan + deterministic extraction → FilterSet patch (NL query)
//   toDiff         before/after → { ops, patch } shown to the user before anything is saved
//
// Nothing here calls a model or the database.

import type { Market } from '../../platform/brand/registry.js';
import { bestTaxonomyMatch } from '../jobs/taxonomy/index.js';
import { findCity } from '../jobs/geo/index.js';
import {
  CN_ONLY_FIELDS,
  INTL_ONLY_FIELDS,
  SENIORITY_LEVELS,
  diffFilterSets,
  mergeFilterSet,
  normalizeFilterSet,
  type FilterField,
  type FilterSet,
  type FilterSetPatch,
} from '../search/index.js';
import type { FilterDiffProposal, HIDE_REASONS } from './contract.js';
import { ANNUAL_FACTOR } from './sql.js';

type HideReason = (typeof HIDE_REASONS)[number];

/** before → after as wire ops (list items added/removed, scalars set; `value: null` clears) and a FilterSetPatch. */
export function toDiff(before: FilterSet, after: FilterSet): Pick<FilterDiffProposal, 'ops' | 'patch'> {
  const ops: FilterDiffProposal['ops'] = [];
  const patch: Record<string, unknown> = {};
  const next = normalizeFilterSet(after) as Record<string, unknown>;
  for (const change of diffFilterSets(before, after)) {
    patch[change.field] = next[change.field] ?? null;
    if (change.addedItems || change.removedItems) {
      for (const v of change.addedItems ?? []) ops.push({ op: 'add', path: change.field, value: v });
      for (const v of change.removedItems ?? []) ops.push({ op: 'remove', path: change.field, value: v });
    } else {
      ops.push({ op: 'set', path: change.field, value: next[change.field] ?? null });
    }
  }
  return { ops, patch: patch as FilterSetPatch };
}

export interface HideJobFacts {
  title: string;
  companyName: string;
  seniority: string | null;
  salaryDisclosed: boolean;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  salaryPeriod: string | null;
}

/** Round a pay floor up to a tidy step for its period. */
function tidyUp(amount: number, period: 'year' | 'month' | 'hour'): number {
  const step = period === 'year' ? 1000 : period === 'month' ? 100 : 1;
  return Math.ceil((amount + 1) / step) * step;
}

/**
 * The deterministic change a "Not interested" reason proposes (ARCH §4.9).
 * `after: null` = no filter change (the note is stored; an editor may open).
 */
export function hideProposal(
  reason: HideReason,
  job: HideJobFacts,
  filters: FilterSet,
): { after: FilterSet | null; editor: 'location' | 'seniority' | null } {
  switch (reason) {
    case 'company':
      return { after: mergeFilterSet(filters, { excludedCompanies: [...(filters.excludedCompanies ?? []), job.companyName] }), editor: null };
    case 'wrong_title':
      return { after: mergeFilterSet(filters, { excludedTitles: [...(filters.excludedTitles ?? []), job.title] }), editor: null };
    case 'wrong_level': {
      if (!job.seniority || !(SENIORITY_LEVELS as readonly string[]).includes(job.seniority)) return { after: null, editor: 'seniority' };
      const current = filters.seniority?.length ? filters.seniority : [...SENIORITY_LEVELS];
      const next = current.filter((l) => l !== job.seniority);
      if (!next.length || next.length === current.length) return { after: null, editor: 'seniority' };
      return { after: mergeFilterSet(filters, { seniority: next }), editor: null };
    }
    case 'wrong_location':
      return { after: null, editor: 'location' };
    case 'pay_too_low': {
      if (!job.salaryDisclosed || (job.salaryMax === null && job.salaryMin === null) || !job.salaryCurrency) {
        // Pay not listed: offer "Only jobs that list pay".
        return filters.includeUndisclosedPay === false ? { after: null, editor: null } : { after: mergeFilterSet(filters, { includeUndisclosedPay: false }), editor: null };
      }
      const raw = job.salaryPeriod ?? 'year';
      const top = (job.salaryMax ?? job.salaryMin) as number;
      // FilterSet periods are year | month | hour; other periods are annualized.
      const period: 'year' | 'month' | 'hour' = raw === 'month' || raw === 'hour' ? raw : 'year';
      const amount = period === raw ? top : top * (ANNUAL_FACTOR[raw] ?? 1);
      const floor = tidyUp(amount, period);
      if (filters.salaryMin && filters.salaryMin.currency === job.salaryCurrency && filters.salaryMin.period === period && filters.salaryMin.amount >= floor) {
        return { after: null, editor: null };
      }
      return { after: mergeFilterSet(filters, { salaryMin: { amount: floor, currency: job.salaryCurrency.toUpperCase(), period } }), editor: null };
    }
    case 'already_applied':
    case 'not_interested':
    case 'other':
      return { after: null, editor: null };
    default: {
      const never: never = reason;
      return never;
    }
  }
}

/** One relaxation per active filter that narrows the SQL (fitTier/preferredCompanies are not SQL). */
export function relaxations(filters: FilterSet): Array<{ field: FilterField; value: unknown; relaxed: FilterSet }> {
  const out: Array<{ field: FilterField; value: unknown; relaxed: FilterSet }> = [];
  const f = normalizeFilterSet(filters) as Record<string, unknown>;
  for (const [field, value] of Object.entries(f) as Array<[FilterField, unknown]>) {
    if (field === 'fitTier' || field === 'preferredCompanies') continue;
    if (field === 'includeUndisclosedPay') {
      if (value === false) out.push({ field, value, relaxed: mergeFilterSet(filters, { includeUndisclosedPay: null }) });
      continue;
    }
    out.push({ field, value, relaxed: mergeFilterSet(filters, { [field]: null } as FilterSetPatch) });
  }
  return out;
}

// ── NL query (F-FEED-17) ─────────────────────────────────────────────────

/** The job-search planner's plan (job-search/agent-validation.ts AgentPlan). */
export interface PlannerPlan {
  queries: string[];
  country?: string;
  location?: string;
  remote?: boolean;
  datePosted?: 'all' | 'today' | '3days' | 'week' | 'month';
  employmentTypes?: Array<'full_time' | 'part_time' | 'contract' | 'internship'>;
  unverifiedPreferences: string[];
}

const DATE_POSTED_DAYS: Record<string, 1 | 3 | 7 | 30> = { today: 1, '3days': 3, week: 7, month: 30 };
const CURRENCY_SIGNS: Array<[RegExp, string]> = [
  [/€|\beur\b|euros?/i, 'EUR'],
  [/£|\bgbp\b|pounds?/i, 'GBP'],
  [/nt\$|\btwd\b|新台幣|新台币/i, 'TWD'],
  [/¥|￥|\bcny\b|\brmb\b|元|人民币|人民幣/i, 'CNY'],
  [/\bjpy\b|円/i, 'JPY'],
  [/\$|\busd\b|dollars?/i, 'USD'],
];

const PAY_NUMBER = /(nt\$|[€£$¥￥])?\s*(\d+(?:[.,]\d{3})*(?:\.\d+)?)\s*(k|千|万|萬|w)?(?![\d])/gi;
const PAY_TRIGGER = /(over|above|at least|more than|min(?:imum)?|from|starting at|pay(?:ing|s)?|salary|earn(?:ing)?|≥|>=|以上|至少|不低于|不低於|薪|月薪|年薪|日薪)/i;
/** GoApply: a number is pay only next to a pay word or a money marker (至少3年经验 / 每周至少4天 are not pay). */
const CN_PAY_WORD = /(薪|工资|工資|待遇|收入|salary|pay|earn)/i;
const CN_MONEY_AFTER = /^\s*(元|块|塊|rmb|cny|人民币|人民幣)/i;
/** A unit right after the number that makes it something other than pay ("3 years", "4天", "2周"); 年薪 / 月薪 stay pay. */
const NOT_PAY_UNIT = /^\s*(?:\+\s*)?(?:(?:years?|yrs?|days?|weeks?|months?|hours?|people)\b|人|年(?!薪)|天|周|週|个月|個月|小时|小時|届|屆)/i;
/** Smallest believable amount per period and currency (CNY): a lower number is not a pay floor. */
const MIN_AMOUNT: Readonly<Record<string, Partial<Record<'year' | 'month' | 'day' | 'hour', number>>>> = {
  CNY: { year: 10_000, month: 500, day: 20, hour: 5 },
  TWD: { year: 100_000, month: 10_000, day: 500, hour: 100 },
  JPY: { year: 500_000, month: 50_000, day: 3000, hour: 500 },
};
const MIN_AMOUNT_DEFAULT: Readonly<Record<'year' | 'month' | 'day' | 'hour', number>> = { year: 1000, month: 100, day: 10, hour: 1 };

export type StatedPay = { amount: number; currency: string; period: 'year' | 'month' | 'day' | 'hour' };

/** The first pay amount the text states, with its currency and period; null when none. */
export function extractPay(text: string, market: Market): StatedPay | null {
  for (const m of text.matchAll(PAY_NUMBER)) {
    const [whole, sign, digits, unitMult] = m;
    const before = text.slice(Math.max(0, (m.index ?? 0) - 25), m.index ?? 0);
    const after = text.slice((m.index ?? 0) + whole.length, (m.index ?? 0) + whole.length + 24);
    if (NOT_PAY_UNIT.test(after)) continue;
    const hasCurrencyWord = /^\s*(eur|usd|gbp|twd|cny|rmb|jpy|元|块|塊|人民币|人民幣|euros?|dollars?)/i.test(after);
    if (market === 'cn') {
      if (!sign && !unitMult && !CN_MONEY_AFTER.test(after) && !CN_PAY_WORD.test(before)) continue;
    } else if (!sign && !unitMult && !hasCurrencyWord && !PAY_TRIGGER.test(before)) continue;
    const n = Number(digits!.replace(/,(?=\d{3})/g, ''));
    if (!Number.isFinite(n) || n <= 0) continue;
    const mult = unitMult ? (/[k千]/i.test(unitMult) ? 1000 : 10_000) : 1;
    const amount = Math.round(n * mult);
    const currencyText = `${sign ?? ''} ${after.slice(0, 12)} ${before}`;
    const currency = CURRENCY_SIGNS.find(([re]) => re.test(currencyText))?.[1] ?? (market === 'cn' ? 'CNY' : null);
    if (!currency) continue;
    const unitText = `${before} ${after}`;
    const period: StatedPay['period'] = /(\/|per|a|an|每)\s*(hour|hr)\b|hourly|时薪|時薪|\/\s*(小时|小時)|每小时|每小時/i.test(unitText)
      ? 'hour'
      : /(\/|per|a|an|每)\s*day\b|daily|日薪|\/\s*天|每天|元\s*\/\s*天/i.test(unitText)
        ? 'day'
        : /(\/|per|a|an|每)\s*(month|mo)\b|monthly|月薪|\/\s*月|每月/i.test(unitText)
          ? 'month'
          : /(\/|per|a|an|每)\s*(year|yr|annum)\b|annual|yearly|年薪|\/\s*年/i.test(unitText)
            ? 'year'
            : market === 'cn'
              ? 'month'
              : 'year';
    const min = MIN_AMOUNT[currency]?.[period] ?? MIN_AMOUNT_DEFAULT[period];
    if (amount < min) continue;
    return { amount, currency, period };
  }
  return null;
}

/**
 * "paying over €70k", "at least $180,000 a year", "月薪2万以上", "15k/month" →
 * a FilterSet pay floor; null when none is stated. A day rate is annualized
 * outside GoApply; on GoApply it is a 元/天 floor instead (see planToFilters).
 */
export function extractPayFloor(text: string, market: Market): FilterSet['salaryMin'] | null {
  const pay = extractPay(text, market);
  if (!pay) return null;
  if (pay.period !== 'day') return { amount: pay.amount, currency: pay.currency, period: pay.period };
  if (market === 'cn') return null;
  return { amount: Math.round(pay.amount * (ANNUAL_FACTOR.day ?? 260)), currency: pay.currency, period: 'year' };
}

/** GoApply "日薪200以上" / "200元/天" → the internship 元/天 floor. */
function extractDailyPay(text: string, market: Market): FilterSet['dailyPay'] | null {
  if (market !== 'cn') return null;
  const pay = extractPay(text, market);
  return pay && pay.period === 'day' && pay.currency === 'CNY' && pay.amount <= 100_000 ? { min: pay.amount } : null;
}

/**
 * Plan → FilterSet patch. Supported constraints become filters; the rest
 * (in the user's words) are returned as `unmatched` and never claimed checked.
 */
export function planToFilters(plan: PlannerPlan, text: string, market: Market): { patch: FilterSetPatch; unmatched: string[] } {
  const patch: FilterSetPatch = {};
  const titles = plan.queries.map((q) => q.trim()).filter(Boolean).slice(0, 2);
  if (titles.length) {
    patch.titles = titles;
    const ids = titles.map((t) => bestTaxonomyMatch(t)?.id).filter((x): x is string => !!x);
    if (ids.length) patch.taxonomyIds = [...new Set(ids)];
  }
  if (plan.country && /^[a-z]{2}$/i.test(plan.country)) patch.country = plan.country.toUpperCase();
  if (plan.location?.trim()) {
    const label = plan.location.trim().slice(0, 160);
    const rec = findCity(label.split(',')[0]!.trim(), { country: patch.country ?? null });
    patch.locations = [
      rec
        ? { label, city: rec.name, country: rec.country, lat: rec.lat, lng: rec.lng, radiusKm: 40 }
        : { label, city: label.split(',')[0]!.trim().slice(0, 120), ...(patch.country ? { country: patch.country } : {}), radiusKm: 0 },
    ];
  }
  if (plan.remote === true) patch.workModels = ['remote'];
  if (plan.datePosted && DATE_POSTED_DAYS[plan.datePosted]) patch.postedWithinDays = DATE_POSTED_DAYS[plan.datePosted];
  if (plan.employmentTypes?.length) patch.jobTypes = [...new Set(plan.employmentTypes)];

  const unmatched: string[] = [];
  for (const pref of plan.unverifiedPreferences) {
    const p = pref.trim();
    if (!p) continue;
    const pay = !patch.salaryMin ? extractPayFloor(p, market) : null;
    if (pay) {
      patch.salaryMin = pay;
      continue;
    }
    const daily = !patch.dailyPay ? extractDailyPay(p, market) : null;
    if (daily) {
      patch.dailyPay = daily;
      continue;
    }
    if (market === 'intl' && /visa|sponsor/i.test(p) && !/\bno\b|\bnot\b|without/i.test(p)) {
      patch.needsSponsorship = true;
      continue;
    }
    if (/agenc|recruit(?:ing|ment) firm|staffing|猎头|獵頭|中介/i.test(p) && /no|not|exclude|avoid|without|不要|排除/i.test(p)) {
      patch.excludeAgencies = true;
      continue;
    }
    unmatched.push(p.slice(0, 240));
  }
  if (!patch.salaryMin && !patch.dailyPay) {
    const pay = extractPayFloor(text, market);
    const daily = pay ? null : extractDailyPay(text, market);
    if (pay) patch.salaryMin = pay;
    else if (daily) patch.dailyPay = daily;
  }
  // Fields of the other market never leave this function.
  const drop = market === 'intl' ? CN_ONLY_FIELDS : INTL_ONLY_FIELDS;
  for (const f of drop) delete (patch as Record<string, unknown>)[f];
  return { patch, unmatched: [...new Set(unmatched)].slice(0, 12) };
}
