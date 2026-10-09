// server/src/features/search/filterSet.ts
//
// Pure FilterSet helpers: parse (strict, for API input), coerce (lenient, for
// stored rows), normalize, merge a patch, diff two sets (the server half of
// the `FilterDiff` component the Assistant and "Not interested" reuse), a
// stable key, and the per-field spec WP-20 (drawer sections) and WP-32 (feed
// predicates) build on.

import type { Market } from '../../platform/brand/registry.js';
import {
  CN_ONLY_FIELDS,
  FILTER_FIELDS,
  FILTER_SET_ALIASES,
  FilterSetPatchSchema,
  FilterSetV1Schema,
  INTL_ONLY_FIELDS,
  type FilterField,
  type FilterSet,
  type FilterSetPatch,
} from './contract.js';

export interface FilterIssue {
  path: string;
  message: string;
}

export type ParseFilterSetResult =
  | { ok: true; value: FilterSet; dropped: FilterField[] }
  | { ok: false; issues: FilterIssue[] };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Rename task-plan shorthand keys to the canonical names (canonical wins when both exist). */
export function applyFilterAliases(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    const canonical = FILTER_SET_ALIASES[k];
    if (canonical) {
      if (!(canonical in input)) out[canonical] = v;
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Fields that do not apply to a market (stripped on write, ignored on read). */
export function fieldsNotForMarket(market: Market): readonly FilterField[] {
  return market === 'cn' ? INTL_ONLY_FIELDS : CN_ONLY_FIELDS;
}

function stripForMarket(fs: FilterSet, market: Market): { value: FilterSet; dropped: FilterField[] } {
  const dropped: FilterField[] = [];
  const value: Record<string, unknown> = { ...fs };
  for (const f of fieldsNotForMarket(market)) {
    if (value[f] !== undefined) {
      dropped.push(f);
      delete value[f];
    }
  }
  return { value: value as FilterSet, dropped };
}

/**
 * Strict parse for API input: unknown keys and invalid values are errors
 * (422 invalid_filters). Fields of the other market are dropped and reported.
 * The result is normalized.
 */
export function parseFilterSet(input: unknown, options: { market: Market }): ParseFilterSetResult {
  if (!isRecord(input)) return { ok: false, issues: [{ path: '', message: 'filters must be an object' }] };
  const parsed = FilterSetV1Schema.safeParse(applyFilterAliases(input));
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) };
  }
  const { value, dropped } = stripForMarket(normalizeFilterSet(parsed.data), options.market);
  return { ok: true, value, dropped };
}

/**
 * Lenient read for stored JSON (older or hand-edited rows): keeps every field
 * that validates on its own and drops the rest, so one bad field never blanks
 * a user's whole search.
 */
export function coerceFilterSet(raw: unknown, options: { market: Market }): { value: FilterSet; dropped: string[] } {
  if (!isRecord(raw)) return { value: {}, dropped: raw === undefined || raw === null ? [] : ['<root>'] };
  const input = applyFilterAliases(raw);
  const out: Record<string, unknown> = {};
  const dropped: string[] = [];
  const shape = FilterSetV1Schema.shape as Record<string, { safeParse: (v: unknown) => { success: boolean; data?: unknown } }>;
  for (const [k, v] of Object.entries(input)) {
    const field = shape[k];
    if (!field) {
      dropped.push(k);
      continue;
    }
    const r = field.safeParse(v);
    if (r.success && r.data !== undefined) out[k] = r.data;
    else if (!r.success) dropped.push(k);
  }
  const stripped = stripForMarket(normalizeFilterSet(out as FilterSet), options.market);
  return { value: stripped.value, dropped: [...dropped, ...stripped.dropped] };
}

function dedupe<T>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const key = typeof item === 'string' ? item.trim().toLowerCase() : stableStringify(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(typeof item === 'string' ? (item.trim() as T) : item);
  }
  return out;
}

/**
 * Canonical form: trimmed strings, case-insensitive de-duplication (first
 * spelling wins), empty arrays/strings/objects removed. Order of list items is
 * kept (the user's order is meaningful for titles and locations).
 */
export function normalizeFilterSet(fs: FilterSet): FilterSet {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fs)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      const items = dedupe(v.filter((x) => !(typeof x === 'string' && !x.trim())));
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

export function isEmptyFilterSet(fs: FilterSet | null | undefined): boolean {
  return !fs || Object.keys(normalizeFilterSet(fs)).length === 0;
}

/** `includeUndisclosedPay` defaults to true (PRODUCT F-FILT-02). */
export function includesUndisclosedPay(fs: FilterSet): boolean {
  return fs.includeUndisclosedPay !== false;
}

/** Validate a patch (strict). */
export function parseFilterSetPatch(input: unknown): { ok: true; value: FilterSetPatch } | { ok: false; issues: FilterIssue[] } {
  if (!isRecord(input)) return { ok: false, issues: [{ path: '', message: 'patch must be an object' }] };
  const parsed = FilterSetPatchSchema.safeParse(applyFilterAliases(input));
  if (!parsed.success) return { ok: false, issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) };
  return { ok: true, value: parsed.data as FilterSetPatch };
}

/** Apply a patch: a value replaces, `null` clears, absent keeps. Returns a normalized set. */
export function mergeFilterSet(base: FilterSet, patch: FilterSetPatch): FilterSet {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return normalizeFilterSet(out as FilterSet);
}

export interface FilterChange {
  field: FilterField;
  kind: 'added' | 'removed' | 'changed';
  /** List fields: items added / removed. */
  addedItems?: unknown[];
  removedItems?: unknown[];
  from?: unknown;
  to?: unknown;
}

/** What changes between two sets, field by field (FILTER_FIELDS order). */
export function diffFilterSets(before: FilterSet, after: FilterSet): FilterChange[] {
  const a = normalizeFilterSet(before) as Record<string, unknown>;
  const b = normalizeFilterSet(after) as Record<string, unknown>;
  const changes: FilterChange[] = [];
  for (const field of FILTER_FIELDS) {
    const from = a[field];
    const to = b[field];
    if (stableStringify(from) === stableStringify(to)) continue;
    if (Array.isArray(from) || Array.isArray(to)) {
      const fromList = (from as unknown[] | undefined) ?? [];
      const toList = (to as unknown[] | undefined) ?? [];
      const keyOf = (x: unknown) => (typeof x === 'string' ? x.toLowerCase() : stableStringify(x));
      const fromKeys = new Set(fromList.map(keyOf));
      const toKeys = new Set(toList.map(keyOf));
      const addedItems = toList.filter((x) => !fromKeys.has(keyOf(x)));
      const removedItems = fromList.filter((x) => !toKeys.has(keyOf(x)));
      if (!addedItems.length && !removedItems.length) continue; // reordered only
      changes.push({
        field,
        kind: from === undefined ? 'added' : to === undefined ? 'removed' : 'changed',
        addedItems,
        removedItems,
      });
      continue;
    }
    changes.push({ field, kind: from === undefined ? 'added' : to === undefined ? 'removed' : 'changed', from, to });
  }
  return changes;
}

/** Deterministic JSON (sorted object keys) for cache keys and equality. */
export function stableStringify(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/** Stable key of a set's meaning (feed count cache, "same search" checks). */
export function filterSetKey(fs: FilterSet): string {
  return stableStringify(normalizeFilterSet(fs));
}

// ── Field spec (drawer sections and feed predicates) ──────────────────────

export type FilterSection = 'basic' | 'pay' | 'interests' | 'companies' | 'view' | 'search' | 'cn';

export interface FilterFieldSpec {
  field: FilterField;
  section: FilterSection;
  markets: readonly Market[];
  /** What the feed predicate does (WP-32 implements it; ruling C15's full predicate list). */
  predicate: string;
}

const BOTH = ['intl', 'cn'] as const;

export const FILTER_FIELD_SPECS: Readonly<Record<FilterField, FilterFieldSpec>> = {
  taxonomyIds: { field: 'taxonomyIds', section: 'basic', markets: BOTH, predicate: 'job.taxonomyId (or an ancestor) is one of these' },
  titles: { field: 'titles', section: 'basic', markets: BOTH, predicate: 'title matches any (normalized text or taxonomy synonym)' },
  excludedTitles: { field: 'excludedTitles', section: 'basic', markets: BOTH, predicate: 'title matches none' },
  jobTypes: { field: 'jobTypes', section: 'basic', markets: BOTH, predicate: 'employment type is one of these' },
  workModels: { field: 'workModels', section: 'basic', markets: BOTH, predicate: 'work model is one of these' },
  country: { field: 'country', section: 'basic', markets: BOTH, predicate: 'job country equals (remote jobs: hiring country includes)' },
  locations: { field: 'locations', section: 'basic', markets: BOTH, predicate: 'within radiusKm of any location (0 = same city); remote jobs pass' },
  seniority: { field: 'seniority', section: 'basic', markets: BOTH, predicate: 'level is one of these' },
  yearsRange: { field: 'yearsRange', section: 'basic', markets: BOTH, predicate: 'required years overlap the range; unknown passes' },
  postedWithinDays: { field: 'postedWithinDays', section: 'basic', markets: BOTH, predicate: 'postedAt within N days' },
  salaryMin: { field: 'salaryMin', section: 'pay', markets: BOTH, predicate: 'max listed pay ≥ amount (same currency and period); undisclosed per includeUndisclosedPay' },
  includeUndisclosedPay: { field: 'includeUndisclosedPay', section: 'pay', markets: BOTH, predicate: 'false hides jobs without listed pay (default true)' },
  needsSponsorship: { field: 'needsSponsorship', section: 'pay', markets: ['intl'], predicate: 'hide "no sponsorship" only when the quote has a negation; sponsorship-mentioned first' },
  excludeRequirements: { field: 'excludeRequirements', section: 'pay', markets: ['intl'], predicate: 'hide jobs whose extracted text requires citizenship / clearance' },
  industries: { field: 'industries', section: 'interests', markets: BOTH, predicate: 'company industry is one of these' },
  excludedIndustries: { field: 'excludedIndustries', section: 'interests', markets: BOTH, predicate: 'company industry is none of these' },
  skills: { field: 'skills', section: 'interests', markets: BOTH, predicate: 'requires any of these skills (ranking boost when no other filter narrows)' },
  excludedSkills: { field: 'excludedSkills', section: 'interests', markets: BOTH, predicate: 'requires none of these skills' },
  roleType: { field: 'roleType', section: 'interests', markets: BOTH, predicate: 'individual contributor vs people manager' },
  companies: { field: 'companies', section: 'companies', markets: BOTH, predicate: 'company is one of these (include-only)' },
  preferredCompanies: { field: 'preferredCompanies', section: 'companies', markets: BOTH, predicate: 'ranking boost only; never filters' },
  excludedCompanies: { field: 'excludedCompanies', section: 'companies', markets: BOTH, predicate: 'company is none of these' },
  companySizes: { field: 'companySizes', section: 'companies', markets: BOTH, predicate: 'company size bucket is one of these; unknown size passes' },
  excludeAgencies: { field: 'excludeAgencies', section: 'companies', markets: BOTH, predicate: 'hide staffing-agency postings' },
  recruiterJobsOnly: { field: 'recruiterJobsOnly', section: 'companies', markets: BOTH, predicate: 'fromRecruiterBank = true (free on every plan)' },
  fitTier: { field: 'fitTier', section: 'view', markets: BOTH, predicate: 'view filter: great ≥80, good ≥65 (MATCH_TIERS); unscored jobs pass' },
  q: { field: 'q', section: 'search', markets: BOTH, predicate: 'title/company keyword search (trigram on searchText)' },
  employerTags: { field: 'employerTags', section: 'cn', markets: ['cn'], predicate: 'marketTags include all chosen tags, each with an evidence quote' },
  classYear: { field: 'classYear', section: 'cn', markets: ['cn'], predicate: '届别 window includes this class; postings without a window pass' },
  degree: { field: 'degree', section: 'cn', markets: ['cn'], predicate: 'stated 学历 requirement is one of these; unstated passes' },
  employmentType: { field: 'employmentType', section: 'cn', markets: ['cn'], predicate: '校招 / 社招 / 实习 is one of these' },
  internDays: { field: 'internDays', section: 'cn', markets: ['cn'], predicate: 'required days a week within the range; unstated passes' },
  dailyPay: { field: 'dailyPay', section: 'cn', markets: ['cn'], predicate: 'internship 元/天 ≥ min; undisclosed per includeUndisclosedPay' },
  hukouTag: { field: 'hukouTag', section: 'cn', markets: ['cn'], predicate: 'official text says 可落户 (evidence quote required)' },
  schoolTiers: { field: 'schoolTiers', section: 'cn', markets: ['cn'], predicate: 'hide postings that state a school-tier requirement the user lacks; never a ranking input' },
};
