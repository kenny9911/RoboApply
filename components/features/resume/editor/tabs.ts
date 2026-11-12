// components/features/resume/editor/tabs.ts — the resume editor's tabs, laid
// out after resume.io's editor (Edit · Customize · Review · Tailor). Pure
// helpers: the tab ids, the `?tab=` parameter that holds the open tab, and
// where a check or analyzer anchor sits in the Edit tab.
//
//   /resume/<id>                  Edit: the form beside the live preview (default, no parameter)
//   /resume/<id>?tab=customize    template, layout, section order, photo and personal details
//   /resume/<id>?tab=review       this resume's latest check, in short
//   /resume/<id>?tab=tailor       start the tailor flow (listed only when AI tailoring may run)
//
// Other parameters (`?tailor=`, `?tailorSession=`, `?focus=`) keep their own
// meaning and survive a tab change.

export const EDITOR_TABS = ['edit', 'customize', 'review', 'tailor'] as const;
export type EditorTab = (typeof EDITOR_TABS)[number];

export const DEFAULT_EDITOR_TAB: EditorTab = 'edit';
export const EDITOR_TAB_QUERY = 'tab';
/** Prefix of the tab and panel DOM ids (`tabPanelProps(EDITOR_TABS_ID, tab)`). */
export const EDITOR_TABS_ID = 'resume-editor';

export function isEditorTab(value: unknown): value is EditorTab {
  return typeof value === 'string' && (EDITOR_TABS as readonly string[]).includes(value);
}

/** The tab a `?tab=` value names; a missing or unknown value opens Edit. */
export function editorTabFrom(raw: string | null | undefined): EditorTab {
  const value = raw?.trim().toLowerCase();
  return isEditorTab(value) ? value : DEFAULT_EDITOR_TAB;
}

/** `search` with `tab` set to `tab` (Edit removes it); every other parameter is kept. */
export function withEditorTab(search: string, tab: EditorTab): string {
  const params = new URLSearchParams(search);
  if (tab === DEFAULT_EDITOR_TAB) params.delete(EDITOR_TAB_QUERY);
  else params.set(EDITOR_TAB_QUERY, tab);
  return params.toString();
}

/** The editor URL that opens on `tab`. */
export function editorTabHref(resumeId: string, tab: EditorTab = DEFAULT_EDITOR_TAB): string {
  const base = `/resume/${encodeURIComponent(resumeId)}`;
  const query = withEditorTab('', tab);
  return query ? `${base}?${query}` : base;
}

/** Check and analyzer anchors → the Edit tab's section ids. */
const SECTION_IDS: Readonly<Record<string, string>> = {
  'section-contact': 'identity',
  'section-target': 'identity',
  'section-summary': 'summary',
  'section-experience': 'experience',
  'section-education': 'education',
  'section-skills': 'skills',
  'section-projects': 'extra-sections',
};

/**
 * The Edit tab element an anchor points at, or null when it points nowhere
 * there (a layout issue). Experience cards carry their `exp-<id>` themselves.
 */
export function editorSectionIdFor(anchor: string | null | undefined): string | null {
  if (!anchor) return null;
  if (anchor.startsWith('exp-')) return anchor;
  return SECTION_IDS[anchor] ?? null;
}
