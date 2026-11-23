// components/features/filters — public surface of the filters UI (WP-20).
// Other areas import from here only (TASK_PLAN.md §2.1 rule 4):
//   WP-33 (/jobs): FilterBar or the pieces, FilterDiff for "Not interested"
//   Today (agent-driven redesign): SearchSummary / useActiveChips for the search in words
//   WP-51 (Assistant): FilterDiff for the proposal card
//   WP-30/31 (onboarding), WP-53 (Ready to apply): FiltersDrawer, editors

export { FilterBar } from './FilterBar';
export { FiltersDrawer } from './FiltersDrawer';
export { activeChips } from './ActiveFilterChips';
export { SavedSearchNote, useProfileLabel } from './SavedSearchSwitcher';
export { FilterDiff } from './FilterDiff';
export { FilterSectionsView, useEditorContext, type DrawerSection } from './FilterSections';
export { useFilterLabels } from './useFilterLabels';
