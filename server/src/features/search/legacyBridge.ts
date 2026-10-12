// server/src/features/search/legacyBridge.ts
//
// The bridge between the legacy RAPreferences blob (GET/PATCH
// /v2/preferences, still read by the current /jobs feed, onboarding confirm
// and the Settings page) and the one preference store, RASearchProfile
// (ARCHITECTURE.md §2.8: "Job-targeting keys stop being written to
// preferencesBlob").
//
//   read:  the job-targeting keys of the blob are PROJECTED from the active
//          search profile's FilterSet (projectFiltersToPreferences);
//   write: a PATCH that changes one of them becomes a FilterSetPatch on the
//          active profile (preferencePatchToFilterPatch). Only keys whose
//          value differs from the projection produce a change, so a client
//          that sends its whole draft back (Settings does) changes nothing.
//
// `companyStages` is no longer stored anywhere: funding stage is not a filter
// (F-FILT-04, no licensed data) and the projection reports none selected.
// `blockedCompanies` stays in the blob (privacy) and its additions/removals
// are mirrored into `excludedCompanies`.
// Pure functions; RAPreferencesService does the I/O.

import { COMPANY_SIZES, JOB_TYPES, PAY_PERIODS, WORK_MODELS, type FilterLocation, type FilterSet, type FilterSetPatch } from './contract.js';

/** Legacy keys whose value now lives in the search profile (never written to the blob). */
export const SEARCH_BACKED_PREFERENCE_KEYS = [
  'roleTitles',
  'workModes',
  'cities',
  'salaryMinK',
  'salaryPeriod',
  'employmentTypes',
  'companyStages',
  'companySizes',
  'industriesTarget',
  'industriesAvoid',
  'targetCompanies',
] as const;
export type SearchBackedPreferenceKey = (typeof SEARCH_BACKED_PREFERENCE_KEYS)[number];

export interface ProjectedPreferences {
  roleTitles: string[];
  workModes: { remote: boolean; hybrid: boolean; onsite: boolean };
  cities: string[];
  salaryMinK: number;
  salaryPeriod: 'year' | 'month' | 'hour';
  employmentTypes: string[];
  companyStages: Record<string, boolean>;
  companySizes: string[];
  industriesTarget: string[];
  industriesAvoid: string[];
  targetCompanies: string[];
}

const LEGACY_STAGE_IDS = ['seed', 'seriesA', 'seriesB', 'seriesC', 'late', 'public'] as const;
const MIGRATED_RADIUS_KM = 40;

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim()) : [];
}

function rec(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

const toLegacySize = (s: string) => s.replace('-', '–');
const fromLegacySize = (s: string): string | undefined => {
  const v = s.replace(/[‒-―]/g, '-').replace(/\s+/g, '');
  return (COMPANY_SIZES as readonly string[]).includes(v) ? v : undefined;
};

/** The legacy job-targeting keys as the active profile's FilterSet says them. */
export function projectFiltersToPreferences(fs: FilterSet): ProjectedPreferences {
  const models = fs.workModels;
  return {
    roleTitles: [...(fs.titles ?? [])],
    // No work-model filter means "any": every mode on.
    workModes: {
      remote: !models || models.includes('remote'),
      hybrid: !models || models.includes('hybrid'),
      onsite: !models || models.includes('onsite'),
    },
    cities: (fs.locations ?? []).map((l) => l.city ?? l.label),
    salaryMinK: fs.salaryMin ? Math.round(fs.salaryMin.amount / 1000) : 0,
    salaryPeriod: fs.salaryMin?.period ?? 'year',
    employmentTypes: [...(fs.jobTypes ?? [])],
    companyStages: Object.fromEntries(LEGACY_STAGE_IDS.map((id) => [id, false])),
    companySizes: (fs.companySizes ?? []).map(toLegacySize),
    industriesTarget: [...(fs.industries ?? [])],
    industriesAvoid: [...(fs.excludedIndustries ?? [])],
    targetCompanies: [...(fs.preferredCompanies ?? [])],
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const listOrNull = <T>(items: T[]): T[] | null => (items.length ? items : null);

export interface BridgeContext {
  /** The active profile's current filters. */
  current: FilterSet;
  /** Currency for a new pay floor (the existing floor's, else the brand's). */
  currency: string;
  /** `blockedCompanies` as stored in the blob before this patch. */
  blockedBefore: string[];
}

/**
 * The FilterSetPatch a legacy preferences patch implies, or null when it
 * changes nothing the search profile holds. `workModes` is a partial
 * (deep-merged) object on the legacy wire, so it is merged over the
 * projection first.
 */
export function preferencePatchToFilterPatch(patch: Record<string, unknown>, ctx: BridgeContext): FilterSetPatch | null {
  const projected = projectFiltersToPreferences(ctx.current);
  const out: FilterSetPatch = {};
  const changed = (key: SearchBackedPreferenceKey) => key in patch && patch[key] !== undefined && !same(patch[key], projected[key]);

  if (changed('roleTitles')) out.titles = listOrNull(strings(patch.roleTitles));

  if ('workModes' in patch && patch.workModes !== undefined) {
    const merged = { ...projected.workModes, ...rec(patch.workModes) } as Record<string, unknown>;
    if (!same(merged, projected.workModes)) {
      const on = WORK_MODELS.filter((m) => merged[m] === true);
      out.workModels = on.length > 0 && on.length < WORK_MODELS.length ? on : null;
    }
  }

  if (changed('cities')) {
    const existing = ctx.current.locations ?? [];
    const cities = strings(patch.cities);
    const locations: FilterLocation[] = cities.map((city) => {
      const keep = existing.find((l) => (l.city ?? l.label).toLowerCase() === city.toLowerCase());
      return keep ?? { label: city, city, radiusKm: MIGRATED_RADIUS_KM };
    });
    out.locations = listOrNull(locations);
  }

  if (changed('salaryMinK') || changed('salaryPeriod')) {
    const k = typeof patch.salaryMinK === 'number' ? patch.salaryMinK : projected.salaryMinK;
    const rawPeriod = typeof patch.salaryPeriod === 'string' ? patch.salaryPeriod : projected.salaryPeriod;
    const period = (PAY_PERIODS as readonly string[]).includes(rawPeriod) ? (rawPeriod as 'year' | 'month' | 'hour') : 'year';
    out.salaryMin =
      k > 0 ? { amount: Math.round(k * 1000), currency: ctx.current.salaryMin?.currency ?? ctx.currency, period } : null;
  }

  if (changed('employmentTypes')) {
    out.jobTypes = listOrNull(strings(patch.employmentTypes).filter((t): t is (typeof JOB_TYPES)[number] => (JOB_TYPES as readonly string[]).includes(t)));
  }
  if (changed('companySizes')) {
    out.companySizes = listOrNull(
      strings(patch.companySizes)
        .map(fromLegacySize)
        .filter((s): s is (typeof COMPANY_SIZES)[number] => !!s),
    );
  }
  if (changed('industriesTarget')) out.industries = listOrNull(strings(patch.industriesTarget));
  if (changed('industriesAvoid')) out.excludedIndustries = listOrNull(strings(patch.industriesAvoid));
  if (changed('targetCompanies')) out.preferredCompanies = listOrNull(strings(patch.targetCompanies));

  if ('blockedCompanies' in patch && Array.isArray(patch.blockedCompanies)) {
    const before = new Set(ctx.blockedBefore.map((c) => c.toLowerCase()));
    const after = strings(patch.blockedCompanies);
    const afterKeys = new Set(after.map((c) => c.toLowerCase()));
    const added = after.filter((c) => !before.has(c.toLowerCase()));
    const removed = new Set(ctx.blockedBefore.filter((c) => !afterKeys.has(c.toLowerCase())).map((c) => c.toLowerCase()));
    if (added.length || removed.size) {
      const excluded = (ctx.current.excludedCompanies ?? []).filter((c) => !removed.has(c.toLowerCase()));
      const have = new Set(excluded.map((c) => c.toLowerCase()));
      for (const c of added) if (!have.has(c.toLowerCase())) excluded.push(c);
      out.excludedCompanies = listOrNull(excluded);
    }
  }

  // `companyStages` is accepted and ignored: funding stage is not a filter.
  return Object.keys(out).length ? out : null;
}
