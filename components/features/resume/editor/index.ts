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
  editorSectionIdFor,
  type EditorTab,
} from './tabs';
export { useEditorTab, useOpenedTabs } from './useEditorTab';
export { EditorTabBar, EditorTabPanel } from './EditorTabBar';
export { CustomizePanel } from './CustomizePanel';
export { ReviewPanel } from './ReviewPanel';
export { TailorTab } from './TailorTab';
