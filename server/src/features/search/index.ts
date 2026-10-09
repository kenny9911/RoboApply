// server/src/features/search/index.ts — public surface of PREF (search profiles).
// Other areas import from here only (TASK_PLAN.md §2.1 rule 4). FND-5 adds
// `routes.ts`; WP-20 fills it over `searchProfileService`.

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
  InvalidFiltersError,
  LastProfileError,
  SavedSearchLimitError,
  SearchProfileNotFoundError,
  VersionConflictError,
  createSearchProfileService,
  searchErrorToHttp,
  searchProfileService,
} from './SearchProfileService.js';
export type { CreateProfileInput, SearchProfileError, SearchProfileService, UpdateProfileInput } from './SearchProfileService.js';
