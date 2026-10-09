// components/features/filters — public surface of the filters UI (WP-20).
// Other areas import from here only (TASK_PLAN.md §2.1 rule 4):
//   WP-33 (/jobs): FilterBar or the pieces, FilterDiff for "Not interested"
//   WP-51 (Assistant): FilterDiff for the proposal card
//   WP-30/31 (onboarding), WP-53 (Ready to apply): FiltersDrawer, editors

export { FilterBar, type FilterBarProps } from './FilterBar';
export { FiltersDrawer, type FiltersDrawerProps } from './FiltersDrawer';
export { QuickFilterBar, quickFilters, type QuickFilterBarProps, type QuickFilterId } from './QuickFilterBar';
export { ActiveFilterChips, activeChips, type ActiveChip, type ActiveFilterChipsProps } from './ActiveFilterChips';
export { FitTierFilter, type FitTierFilterProps } from './FitTierFilter';
export { SearchTypeahead, type SearchTypeaheadProps } from './SearchTypeahead';
export { SavedSearchSwitcher, SavedSearchNote, profileLabel, useProfileLabel, type ProfileLabels, type SavedSearchSwitcherProps } from './SavedSearchSwitcher';
export { FilterDiff, type FilterDiffProps } from './FilterDiff';
export { FilterSectionsView, sectionEditors, useEditorContext, type DrawerSection } from './FilterSections';
export type { EditorContext, EditorProps } from './FilterEditors';
export { useFilterLabels, type FilterLabels } from './useFilterLabels';
