// server/src/features/search/legacyMigration.ts
//
// One-time migration of the legacy job-targeting preferences into search
// profiles (ARCHITECTURE.md §2.8 "Migration"):
//   - RACareerGoal (targetTitle, salary, preferredLocations, preferredWorkType,
//     seniority) + its `preferencesBlob` (RAPreferences) → the default profile;
//   - each RASavedSearch row → a non-default profile.
//
// Every legacy key has a recorded disposition (LEGACY_PREFERENCE_KEYS etc.),
// checked at compile time against the RAPreferences type, so a key added
// later cannot be silently ignored. Nothing is inferred from free text (D3):
// `workAuth`, `mustHaves` and `dealbreakers` stay in the blob as they are.
// Pure functions; SearchProfileService does the I/O.

import type { RAPreferences } from '../../roboapply/v2/services/RAPreferencesService.js';
import type { Market } from '../../platform/brand/registry.js';
import { COMPANY_SIZES, JOB_TYPES, PAY_PERIODS, WORK_MODELS, type FilterField, type FilterSet } from './contract.js';
import { coerceFilterSet } from './filterSet.js';

export type LegacyDisposition =
  | { action: 'mapped'; to: FilterField; note?: string }
  | { action: 'kept'; note: string }
  | { action: 'dropped'; note: string };

const kept = (note: string): LegacyDisposition => ({ action: 'kept', note });
const dropped = (note: string): LegacyDisposition => ({ action: 'dropped', note });
const mapped = (to: FilterField, note?: string): LegacyDisposition => ({ action: 'mapped', to, ...(note ? { note } : {}) });

/** Every RAPreferences key. 'kept' = stays in preferencesBlob (not a search filter). */
export const LEGACY_PREFERENCE_KEYS = {
  phone: kept('identity'),
  location: kept('identity (free text; not a search location)'),
  pronouns: kept('identity'),
  yearsExp: kept('profile fact, not a filter'),
  defaultResumeId: kept('resume settings'),
  links: kept('identity'),
  huntActive: kept('profile status'),
  intentMarkdown: kept('free text'),
  roleTitles: mapped('titles'),
  workModes: mapped('workModels', 'true keys only; all-false or all-true means any'),
  cities: mapped('locations', 'label = city, radius 40 km, country only when the goal names exactly one'),
  salaryMinK: mapped('salaryMin', 'K × 1000 in the goal currency (or the brand currency)'),
  salaryMaxK: dropped('there is no maximum-pay filter'),
  salaryPeriod: mapped('salaryMin', 'period of salaryMin'),
  employmentTypes: mapped('jobTypes'),
  companyStages: dropped('funding stage is not a filter (F-FILT-04, no licensed data)'),
  companySizes: mapped('companySizes', 'en dash → hyphen; unknown buckets dropped'),
  industriesTarget: mapped('industries'),
  industriesAvoid: mapped('excludedIndustries'),
  targetCompanies: mapped('preferredCompanies', 'a boost, never an include-only filter'),
  mustHaves: kept('free text; never parsed into filters (D3)'),
  dealbreakers: kept('free text; never parsed into filters (D3)'),
  workAuth: kept('free text; sponsorship is never inferred from it (D3)'),
  aggressiveness: dropped('dead agent knob'),
  matchThreshold: dropped('dead agent knob'),
  dailyCap: dropped('dead agent knob'),
  quietStart: dropped('dead agent knob'),
  quietEnd: dropped('dead agent knob'),
  autoDecline: dropped('dead agent knob'),
  autoSchedule: dropped('dead agent knob'),
  pauseDuringInterviews: kept('agent preference'),
  reScoreWeekly: kept('agent preference'),
  coachLoudness: kept('coaching preference'),
  channels: kept('notifications'),
  digest: kept('notifications'),
  notif: kept('notifications'),
  profileVisibility: kept('privacy'),
  blockedCompanies: mapped('excludedCompanies', 'also stays in the blob for privacy'),
  blockedRecruiters: kept('privacy'),
  dataRetention: kept('privacy'),
  plan: kept('read-only mirror of billing'),
  onboarding: kept('onboarding provenance'),
  updatedAt: kept('timestamp'),
} as const satisfies Record<keyof RAPreferences, LegacyDisposition>;

/** RACareerGoal columns that carry job targeting. */
export const LEGACY_GOAL_KEYS = {
  targetTitle: mapped('titles', 'first title'),
  targetSalaryMin: mapped('salaryMin', 'yearly, used when the blob has no salaryMinK'),
  targetSalaryMax: dropped('there is no maximum-pay filter'),
  targetSalaryCurrency: mapped('salaryMin', 'currency'),
  preferredLocations: mapped('locations', 'cities → locations; one country → country; remoteOk/hybridOk → workModels'),
  preferredWorkType: mapped('workModels'),
  seniority: mapped('seniority', 'ic→mid, senior→senior, staff/principal→lead_staff, director/vp/cxo→director_exec, manager→roleType manager'),
  targetDate: kept('goal surface'),
  weeklyApplicationGoal: kept('goal surface'),
  notesMarkdown: kept('goal surface'),
} as const satisfies Record<string, LegacyDisposition>;

/** RASavedSearch.query keys (the V2 SearchQuery shape). */
export const LEGACY_SAVED_SEARCH_KEYS = {
  q: mapped('q'),
  location: mapped('locations', 'label = location, radius 40 km'),
  workType: mapped('workModels'),
  salaryMin: mapped('salaryMin', 'yearly'),
  salaryCurrency: mapped('salaryMin', 'currency'),
  datePosted: mapped('postedWithinDays', 'today→1, 7d→7, 30d→30, any→none'),
  sortBy: dropped('sort order is a view setting, not a filter'),
  employmentType: mapped('jobTypes'),
} as const satisfies Record<string, LegacyDisposition>;

export interface LegacyGoalRow {
  targetTitle?: string | null;
  targetSalaryMin?: number | null;
  targetSalaryCurrency?: string | null;
  preferredLocations?: unknown;
  preferredWorkType?: string | null;
  seniority?: string | null;
  preferencesBlob?: unknown;
}

export interface LegacySavedSearchRow {
  id: string;
  name: string;
  query: unknown;
  createdAt?: Date;
}

export interface MigratedProfile {
  name: string;
  isDefault: boolean;
  isActive: boolean;
  filters: FilterSet;
  /** Provenance for logs: 'goal' or 'saved_search:<id>'. */
  source: string;
}

const MIGRATED_RADIUS_KM = 40;

function rec(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim()) : [];
}

function currencyOr(v: unknown, fallback: string): string {
  return typeof v === 'string' && /^[A-Za-z]{3}$/.test(v.trim()) ? v.trim().toUpperCase() : fallback;
}

function countryCode(v: string): string | undefined {
  const c = v.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(c) ? c : undefined;
}

const SENIORITY_MAP: Record<string, { seniority?: FilterSet['seniority']; roleType?: FilterSet['roleType'] }> = {
  ic: { seniority: ['mid'] },
  senior: { seniority: ['senior'] },
  staff: { seniority: ['lead_staff'] },
  principal: { seniority: ['lead_staff'] },
  manager: { roleType: 'manager' },
  director: { seniority: ['director_exec'] },
  vp: { seniority: ['director_exec'] },
  cxo: { seniority: ['director_exec'] },
};

function workModelsFrom(modes: Record<string, unknown>): FilterSet['workModels'] {
  const on = WORK_MODELS.filter((m) => modes[m] === true);
  // Everything on (or nothing on) means "any": no filter.
  return on.length > 0 && on.length < WORK_MODELS.length ? on : undefined;
}

function sizeBucket(v: string): string | undefined {
  const s = v.replace(/[‒-―]/g, '-').replace(/\s+/g, '');
  return (COMPANY_SIZES as readonly string[]).includes(s) ? s : undefined;
}

/** The default profile's filters from the goal row and its preferences blob. */
export function filterSetFromLegacyGoal(goal: LegacyGoalRow | null, options: { market: Market; currency: string }): FilterSet {
  if (!goal) return {};
  const blob = rec(goal.preferencesBlob);
  const locs = rec(goal.preferredLocations);
  const fs: Record<string, unknown> = {};

  const titles = [...(goal.targetTitle?.trim() ? [goal.targetTitle.trim()] : []), ...strings(blob.roleTitles)];
  if (titles.length) fs.titles = titles;

  // Work model: the blob's richer knob first, then the goal's.
  let workModels = workModelsFrom(rec(blob.workModes));
  if (!workModels && typeof goal.preferredWorkType === 'string' && (WORK_MODELS as readonly string[]).includes(goal.preferredWorkType)) {
    // The goal's remoteOk / hybridOk widen its one work type; without a work type they mean "any".
    const set = new Set<string>([goal.preferredWorkType]);
    if (locs.remoteOk === true) set.add('remote');
    if (locs.hybridOk === true) set.add('hybrid');
    workModels = set.size < WORK_MODELS.length ? (WORK_MODELS.filter((m) => set.has(m)) as FilterSet['workModels']) : undefined;
  }
  if (workModels) fs.workModels = workModels;

  const countries = strings(locs.countries).map(countryCode).filter((c): c is string => !!c);
  const country = countries.length === 1 ? countries[0] : undefined;
  if (country) fs.country = country;
  const cities = [...strings(blob.cities), ...strings(locs.cities)];
  if (cities.length) {
    fs.locations = cities.map((city) => ({ label: city, city, ...(country ? { country } : {}), radiusKm: MIGRATED_RADIUS_KM }));
  }

  const salaryMinK = typeof blob.salaryMinK === 'number' && blob.salaryMinK > 0 ? blob.salaryMinK : null;
  const period = typeof blob.salaryPeriod === 'string' && (PAY_PERIODS as readonly string[]).includes(blob.salaryPeriod) ? blob.salaryPeriod : 'year';
  const currency = currencyOr(goal.targetSalaryCurrency, options.currency);
  if (salaryMinK) fs.salaryMin = { amount: Math.round(salaryMinK * 1000), currency, period };
  else if (typeof goal.targetSalaryMin === 'number' && goal.targetSalaryMin > 0) fs.salaryMin = { amount: goal.targetSalaryMin, currency, period: 'year' };

  const jobTypes = strings(blob.employmentTypes).filter((t) => (JOB_TYPES as readonly string[]).includes(t));
  if (jobTypes.length) fs.jobTypes = jobTypes;

  const sizes = strings(blob.companySizes).map(sizeBucket).filter((s): s is string => !!s);
  if (sizes.length) fs.companySizes = sizes;

  const industries = strings(blob.industriesTarget);
  if (industries.length) fs.industries = industries;
  const excludedIndustries = strings(blob.industriesAvoid);
  if (excludedIndustries.length) fs.excludedIndustries = excludedIndustries;
  const preferred = strings(blob.targetCompanies);
  if (preferred.length) fs.preferredCompanies = preferred;
  const blocked = strings(blob.blockedCompanies);
  if (blocked.length) fs.excludedCompanies = blocked;

  const sen = goal.seniority ? SENIORITY_MAP[goal.seniority] : undefined;
  if (sen?.seniority) fs.seniority = sen.seniority;
  if (sen?.roleType) fs.roleType = sen.roleType;

  return coerceFilterSet(fs, { market: options.market }).value;
}

const DATE_POSTED: Record<string, number> = { today: 1, '7d': 7, '30d': 30 };

/** A saved search's filters from its V2 SearchQuery. */
export function filterSetFromSavedSearch(query: unknown, options: { market: Market; currency: string }): FilterSet {
  const q = rec(query);
  const fs: Record<string, unknown> = {};
  if (typeof q.q === 'string' && q.q.trim()) fs.q = q.q.trim();
  if (typeof q.location === 'string' && q.location.trim()) fs.locations = [{ label: q.location.trim(), radiusKm: MIGRATED_RADIUS_KM }];
  if (typeof q.workType === 'string' && (WORK_MODELS as readonly string[]).includes(q.workType)) fs.workModels = [q.workType];
  if (typeof q.salaryMin === 'number' && q.salaryMin > 0) {
    fs.salaryMin = { amount: q.salaryMin, currency: currencyOr(q.salaryCurrency, options.currency), period: 'year' };
  }
  if (typeof q.datePosted === 'string' && DATE_POSTED[q.datePosted]) fs.postedWithinDays = DATE_POSTED[q.datePosted];
  if (typeof q.employmentType === 'string' && (JOB_TYPES as readonly string[]).includes(q.employmentType)) fs.jobTypes = [q.employmentType];
  return coerceFilterSet(fs, { market: options.market }).value;
}

/**
 * The profiles a user with no search profiles gets: one default (and active)
 * profile from the goal, even when it is empty, plus one non-default profile
 * per saved search.
 */
export function buildLegacyProfiles(input: {
  goal: LegacyGoalRow | null;
  savedSearches: LegacySavedSearchRow[];
  market: Market;
  currency: string;
}): MigratedProfile[] {
  const opts = { market: input.market, currency: input.currency };
  const out: MigratedProfile[] = [
    {
      name: input.goal?.targetTitle?.trim().slice(0, 60) ?? '',
      isDefault: true,
      isActive: true,
      filters: filterSetFromLegacyGoal(input.goal, opts),
      source: 'goal',
    },
  ];
  const sorted = [...input.savedSearches].sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0));
  for (const s of sorted) {
    out.push({
      name: s.name.trim().slice(0, 60),
      isDefault: false,
      isActive: false,
      filters: filterSetFromSavedSearch(s.query, opts),
      source: `saved_search:${s.id}`,
    });
  }
  return out;
}
