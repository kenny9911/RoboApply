// components/features/resume/editor — the resume editor's tabs after
// resume.io's editor: Edit · Customize · Review · Tailor (New), the open tab
// in `?tab=`. The editor page (app/(auth)/resume/[id]) renders the bar and
// the panels; the Edit tab is the editor's own form.
//
//   <EditorTabBar value onChange tailor />      the tab strip under the toolbar
//   <EditorTabPanel tab active>…</EditorTabPanel>
//   <CustomizePanel …/>                          template and layout, section order, details
//   <ReviewPanel resumeId onShowSection onCustomize />   the latest check in short
//   <TailorTab resumeId onTailor />              start the tailor flow for this resume
//   useEditorTab() / useOpenedTabs(tab)          the tab in the URL / tabs opened so far
//   editorTabHref(id, 'review')                  a link that opens a tab

export {
  DEFAULT_EDITOR_TAB,
  EDITOR_TABS,
  EDITOR_TABS_ID,
  EDITOR_TAB_QUERY,
  editorSectionIdFor,
  editorTabFrom,
  editorTabHref,
  isEditorTab,
  withEditorTab,
  type EditorTab,
} from './tabs';
export { useEditorTab, useOpenedTabs, type EditorTabState } from './useEditorTab';
export { EditorTabBar, EditorTabPanel, type EditorTabBarProps } from './EditorTabBar';
export { CustomizePanel, type CustomizePanelProps } from './CustomizePanel';
export { ReviewPanel, type ReviewPanelProps } from './ReviewPanel';
export { TailorTab, type TailorChoice, type TailorTabProps } from './TailorTab';
