// hooks/search/keys.ts — TanStack Query keys of the search area (WP-20).
// Kept in their own module so hooks/usePreferences.ts can invalidate them
// without importing the search hooks (and vice versa).

export const searchKeys = {
  all: ['search'] as const,
  profiles: () => ['search', 'profiles'] as const,
  count: (filtersKey: string) => ['search', 'count', filtersKey] as const,
  limiting: (profileId: string, version: number) => ['search', 'limiting', profileId, version] as const,
  taxonomy: (q: string, locale: string) => ['search', 'taxonomy', locale, q] as const,
  skills: (q: string) => ['search', 'skills', q] as const,
  companies: (q: string) => ['search', 'companies', q] as const,
};

/** The legacy preferences key (hooks/usePreferences.ts): it projects the active search profile. */
export const LEGACY_PREFERENCES_KEY = ['v3', 'preferences'] as const;

/**
 * Legacy RAPreferences keys the server projects from the active search
 * profile (server/src/features/search/legacyBridge.ts). A client that sends
 * its whole preferences draft must not send these back unchanged.
 */
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

/** Drop search-backed keys whose value equals what the server last projected (unchanged in the draft). */
export function withoutUnchangedSearchKeys<T extends Record<string, unknown>>(body: T, server: Record<string, unknown> | null | undefined): T {
  if (!server) return body;
  const out: Record<string, unknown> = { ...body };
  for (const k of SEARCH_BACKED_PREFERENCE_KEYS) {
    if (k in out && JSON.stringify(out[k]) === JSON.stringify(server[k])) delete out[k];
  }
  return out as T;
}
