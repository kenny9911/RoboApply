// hooks/search/filterModel.ts — the client half of FilterSet v1 (WP-20).
//
// Pure helpers the filters drawer, quick bar, chips and FilterDiff share:
// option lists (typed against the server contract, so a renamed enum value
// fails the build), normalize / merge / diff / patch-between, the active
// count, radius units by country and the per-country sponsorship answer.
// The server twin is server/src/features/search/filterSet.ts; the client
// cannot import server runtime code (lib/api/contracts are type-only), so
// the few algorithms both need are mirrored here and tested on their own.

import type * as S from '../../lib/api/contracts/search';

export type FilterSet = S.FilterSet;
export type FilterField = S.FilterField;
export type FilterSetPatch = S.FilterSetPatch;
export type FilterLocation = S.FilterLocation;

type Item<K extends FilterField> = NonNullable<FilterSet[K]> extends readonly (infer U)[] ? U : never;

/** Exhaustive list of a union: `options<Union>()({a: true, b: true})` fails to compile when one is missing. */
const allOf =
  <T extends string>() =>
  <R extends Record<T, true>>(r: R & Record<Exclude<keyof R, T>, never>): T[] =>
    Object.keys(r) as T[];

export const JOB_TYPES = allOf<Item<'jobTypes'>>()({ full_time: true, part_time: true, contract: true, internship: true });
export const WORK_MODELS = allOf<Item<'workModels'>>()({ remote: true, hybrid: true, onsite: true });
export const SENIORITY_LEVELS = allOf<Item<'seniority'>>()({
  intern_newgrad: true,
  entry: true,
  mid: true,
  senior: true,
  lead_staff: true,
  director_exec: true,
});
export const COMPANY_SIZES = allOf<Item<'companySizes'>>()({
  '1-10': true,
  '11-50': true,
  '51-200': true,
  '201-1000': true,
  '1001-5000': true,
  '5000+': true,
});
export const EXCLUDE_REQUIREMENTS = allOf<Item<'excludeRequirements'>>()({ citizenship: true, clearance: true });
export const EMPLOYER_TAGS = allOf<Item<'employerTags'>>()({ soe: true, bianzhi: true, hukou: true, foreign: true });
export const CN_DEGREES = allOf<Item<'degree'>>()({ dazhuan: true, bachelor: true, master: true, phd: true });
export const CN_EMPLOYMENT_TYPES = allOf<Item<'employmentType'>>()({ campus: true, social: true, internship: true });
export const SCHOOL_TIERS = allOf<Item<'schoolTiers'>>()({ '985': true, '211': true, double_first_class: true });
export const POSTED_WITHIN_DAYS: ReadonlyArray<NonNullable<FilterSet['postedWithinDays']>> = [1, 3, 7, 30];
export const RADIUS_KM: ReadonlyArray<FilterLocation['radiusKm']> = [0, 8, 40, 80, 160];
export const PAY_PERIODS: ReadonlyArray<NonNullable<FilterSet['salaryMin']>['period']> = ['year', 'month', 'hour'];
export const ROLE_TYPES: ReadonlyArray<NonNullable<FilterSet['roleType']>> = ['ic', 'manager'];
export const FIT_TIERS: ReadonlyArray<NonNullable<FilterSet['fitTier']>> = ['great', 'good', 'all'];
export const SALARY_MONTHS = [12, 13, 14, 15, 16, 18] as const;

/** Drawer section of each field (exhaustive; mirrors FILTER_FIELD_SPECS on the server). */
export const FIELD_SECTIONS: Readonly<Record<FilterField, 'basic' | 'pay' | 'interests' | 'companies' | 'view' | 'search' | 'cn'>> = {
  taxonomyIds: 'basic',
  titles: 'basic',
  excludedTitles: 'basic',
  jobTypes: 'basic',
  workModels: 'basic',
  country: 'basic',
  locations: 'basic',
  seniority: 'basic',
  yearsRange: 'basic',
  postedWithinDays: 'basic',
  salaryMin: 'pay',
  includeUndisclosedPay: 'pay',
  needsSponsorship: 'pay',
  excludeRequirements: 'pay',
  industries: 'interests',
  excludedIndustries: 'interests',
  skills: 'interests',
  excludedSkills: 'interests',
  roleType: 'interests',
  companies: 'companies',
  preferredCompanies: 'companies',
  excludedCompanies: 'companies',
  companySizes: 'companies',
  excludeAgencies: 'companies',
  recruiterJobsOnly: 'companies',
  fitTier: 'view',
  q: 'search',
  employerTags: 'cn',
  classYear: 'cn',
  degree: 'cn',
  employmentType: 'cn',
  internDays: 'cn',
  dailyPay: 'cn',
  salaryMonthsMin: 'cn',
  hukouTag: 'cn',
  schoolTiers: 'cn',
};

/** Field order (chips, diff rows). */
export const FIELD_ORDER = Object.keys(FIELD_SECTIONS) as FilterField[];

export const CN_ONLY_FIELDS: readonly FilterField[] = FIELD_ORDER.filter((f) => FIELD_SECTIONS[f] === 'cn');
export const INTL_ONLY_FIELDS: readonly FilterField[] = ['needsSponsorship', 'excludeRequirements'];

export type Market = 'intl' | 'cn';

/** Fields that do not apply to a market (never shown, never sent). */
export function hiddenFieldsFor(market: Market): readonly FilterField[] {
  return market === 'cn' ? INTL_ONLY_FIELDS : CN_ONLY_FIELDS;
}

// ── normalize / merge / diff ─────────────────────────────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Deterministic JSON (sorted keys). */
export function stableStringify(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

const itemKey = (x: unknown) => (typeof x === 'string' ? x.trim().toLowerCase() : stableStringify(x));

/** Drop empty values; trim and de-duplicate list items (first spelling wins). */
export function normalizeFilters(fs: FilterSet): FilterSet {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fs)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      const seen = new Set<string>();
      const items: unknown[] = [];
      for (const x of v) {
        if (typeof x === 'string' && !x.trim()) continue;
        const key = itemKey(x);
        if (seen.has(key)) continue;
        seen.add(key);
        items.push(typeof x === 'string' ? x.trim() : x);
      }
      if (items.length) out[k] = items;
    } else if (typeof v === 'string') {
      if (v.trim()) out[k] = v.trim();
    } else if (isRecord(v)) {
      const inner = Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined));
      if (Object.keys(inner).length) out[k] = inner;
    } else {
      out[k] = v;
    }
  }
  return out as FilterSet;
}

export function filtersKey(fs: FilterSet): string {
  return stableStringify(normalizeFilters(fs));
}

export function sameFilters(a: FilterSet, b: FilterSet): boolean {
  return filtersKey(a) === filtersKey(b);
}

/** A value replaces, `null` clears, absent keeps. */
export function mergePatch(base: FilterSet, patch: FilterSetPatch): FilterSet {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return normalizeFilters(out as FilterSet);
}

/** The patch that turns `before` into `after` (changed fields only; removed → null). */
export function patchBetween(before: FilterSet, after: FilterSet): FilterSetPatch {
  const a = normalizeFilters(before) as Record<string, unknown>;
  const b = normalizeFilters(after) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const f of FIELD_ORDER) {
    if (stableStringify(a[f]) === stableStringify(b[f])) continue;
    out[f] = b[f] === undefined ? null : b[f];
  }
  return out as FilterSetPatch;
}

export interface FilterChange {
  field: FilterField;
  kind: 'added' | 'removed' | 'changed';
  addedItems?: unknown[];
  removedItems?: unknown[];
  from?: unknown;
  to?: unknown;
}

/** Field-by-field changes (FIELD_ORDER), the shape the server's diffFilterSets returns. */
export function diffFilters(before: FilterSet, after: FilterSet): FilterChange[] {
  const a = normalizeFilters(before) as Record<string, unknown>;
  const b = normalizeFilters(after) as Record<string, unknown>;
  const changes: FilterChange[] = [];
  for (const field of FIELD_ORDER) {
    const from = a[field];
    const to = b[field];
    if (stableStringify(from) === stableStringify(to)) continue;
    const kind = from === undefined ? 'added' : to === undefined ? 'removed' : 'changed';
    if (Array.isArray(from) || Array.isArray(to)) {
      const fromList = (from as unknown[] | undefined) ?? [];
      const toList = (to as unknown[] | undefined) ?? [];
      const fromKeys = new Set(fromList.map(itemKey));
      const toKeys = new Set(toList.map(itemKey));
      const addedItems = toList.filter((x) => !fromKeys.has(itemKey(x)));
      const removedItems = fromList.filter((x) => !toKeys.has(itemKey(x)));
      if (!addedItems.length && !removedItems.length) continue;
      changes.push({ field, kind, addedItems, removedItems });
      continue;
    }
    changes.push({ field, kind, from, to });
  }
  return changes;
}

/** How many filters narrow the list (the "Filters (N)" badge). View and defaults do not count. */
export function activeFilterCount(fs: FilterSet): number {
  const n = normalizeFilters(fs) as Record<string, unknown>;
  let count = 0;
  for (const f of FIELD_ORDER) {
    const v = n[f];
    if (v === undefined) continue;
    if (f === 'fitTier' || f === 'preferredCompanies' || f === 'q') continue;
    if (f === 'includeUndisclosedPay') {
      if (v === false) count += 1;
      continue;
    }
    if (v === false) continue;
    count += 1;
  }
  return count;
}

/** `includeUndisclosedPay` defaults to true: "Only jobs that list pay" is off by default. */
export function onlyListedPay(fs: FilterSet): boolean {
  return fs.includeUndisclosedPay === false;
}

// ── Radius: km everywhere, miles where people measure distance in miles ──

/** Countries whose people measure road distance in miles. */
export const MILES_COUNTRIES: ReadonlySet<string> = new Set(['US', 'GB', 'LR', 'MM']);

export type DistanceUnit = 'km' | 'mi';

export function distanceUnitFor(country: string | null | undefined): DistanceUnit {
  return country && MILES_COUNTRIES.has(country.toUpperCase()) ? 'mi' : 'km';
}

/** The stored kilometre steps shown as round miles (8 km ≈ 5 mi … 160 km ≈ 100 mi). */
const KM_TO_ROUND_MILES: Record<number, number> = { 0: 0, 8: 5, 40: 25, 80: 50, 160: 100 };

/** The number shown for a stored radius in a unit. */
export function radiusInUnit(km: FilterLocation['radiusKm'], unit: DistanceUnit): number {
  return unit === 'mi' ? KM_TO_ROUND_MILES[km] ?? Math.round(km / 1.609) : km;
}

// ── Sponsorship (TW-09): one question per country ────────────────────────

export interface WorkAuthEntry {
  country: string;
  authorized: boolean | null;
  sponsorship: 'now' | 'later' | 'no' | null;
}

/** The country the sponsorship question is about: the filter's country, else the first location's, else the brand default. */
export function sponsorshipCountry(fs: FilterSet, fallback: string): string {
  return (fs.country ?? fs.locations?.find((l) => l.country)?.country ?? fallback).toUpperCase();
}

/**
 * The profile's work-authorization answers after the user says whether they
 * need sponsorship in `country`. Only that country's `sponsorship` changes;
 * `authorized` is kept (it is a separate question the profile asks).
 */
export function workAuthWithSponsorship(entries: readonly WorkAuthEntry[], country: string, needs: boolean): WorkAuthEntry[] {
  const code = country.toUpperCase();
  const answer: WorkAuthEntry['sponsorship'] = needs ? 'now' : 'no';
  const existing = entries.find((e) => e.country === code);
  if (existing) return entries.map((e) => (e.country === code ? { ...e, sponsorship: answer } : e));
  return [...entries, { country: code, authorized: null, sponsorship: answer }];
}

/** Years for the 届别 (graduation class) picker: last year through four years ahead. */
export function classYearOptions(now: Date = new Date()): number[] {
  const y = now.getFullYear();
  return [y - 1, y, y + 1, y + 2, y + 3, y + 4];
}
