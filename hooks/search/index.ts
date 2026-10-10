// hooks/search — saved searches, filters and typeahead hooks (WP-20).
// Feed (WP-33), onboarding (WP-30), Ready to apply (WP-53) and the Assistant
// (WP-51) import from here.

export { LEGACY_PREFERENCES_KEY, searchKeys } from './keys';
export * from './filterModel';
export {
  conflictProfile,
  pickActiveProfile,
  searchErrorReason,
  useActivateSearchProfile,
  useActiveSearchProfile,
  useCreateSearchProfile,
  useDeleteSearchProfile,
  useSearchProfiles,
  useUpdateSearchProfile,
} from './useSearchProfiles';
export type { SearchErrorReason, SearchProfile, SearchProfileList, UpdateSearchProfileVars } from './useSearchProfiles';
export {
  COUNT_DEBOUNCE_MS,
  TYPEAHEAD_DEBOUNCE_MS,
  typeaheadReady,
  useCompanySuggestions,
  useDebouncedValue,
  useFilterCount,
  useLimitingFilters,
  useSkillSuggestions,
  useTaxonomyLabels,
  useTaxonomyLabelState,
  useTitleSuggestions,
} from './useFilterQueries';
export type { FilterCountState } from './useFilterQueries';
export { syncSponsorshipAnswer, useApplyFilters, useOptimisticFilters } from './useApplyFilters';
export type { ApplyFiltersInput, ApplyFiltersResult, OptimisticFilters } from './useApplyFilters';
