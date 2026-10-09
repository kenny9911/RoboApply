// server/src/features/search/index.ts — public surface of PREF (search profiles).
// Other areas import from here only (TASK_PLAN.md §2.1 rule 4). FND-5 adds
// `routes.ts`; WP-20 fills it over `searchProfileService`, plus the
// legacy-preferences bridge (`legacyBridge.ts`) RAPreferencesService uses.

export * from './contract.js';
export {
  FILTER_FIELD_SPECS,
  applyFilterAliases,
  coerceFilterSet,
  diffFilterSets,
  fieldsNotForMarket,
  filterSetKey,
  includesUndisclosedPay,
  isEmptyFilterSet,
  mergeFilterSet,
  normalizeFilterSet,
  parseFilterSet,
  parseFilterSetPatch,
  stableStringify,
} from './filterSet.js';
export type { FilterChange, FilterFieldSpec, FilterIssue, FilterSection, ParseFilterSetResult } from './filterSet.js';
export {
  LEGACY_GOAL_KEYS,
  LEGACY_PREFERENCE_KEYS,
  LEGACY_SAVED_SEARCH_KEYS,
  buildLegacyProfiles,
  filterSetFromLegacyGoal,
  filterSetFromSavedSearch,
} from './legacyMigration.js';
export type { LegacyDisposition, LegacyGoalRow, LegacySavedSearchRow, MigratedProfile } from './legacyMigration.js';
export {
  AlertFrequencyNotAllowedError,
  DefaultProfileError,
  InvalidFiltersError,
  LastProfileError,
  SavedSearchLimitError,
  SearchProfileNotFoundError,
  VersionConflictError,
  createSearchProfileService,
  searchErrorToHttp,
  searchErrorToHttpError,
  searchProfileService,
} from './SearchProfileService.js';
export type { CreateProfileInput, SearchProfileError, SearchProfileService, UpdateProfileInput } from './SearchProfileService.js';
export { SEARCH_BACKED_PREFERENCE_KEYS, preferencePatchToFilterPatch, projectFiltersToPreferences } from './legacyBridge.js';
export type { BridgeContext, ProjectedPreferences, SearchBackedPreferenceKey } from './legacyBridge.js';
