'use client';

// useEditorTab — the open editor tab, kept in the URL (`?tab=`, see ./tabs)
// with router.replace and no scroll jump, so a link can open a tab and Back
// returns to the tab the user left. A click switches the tab at once and the
// URL follows; when the URL changes by itself (Back, Forward, a link to
// another tab of this resume) the tab follows the URL.
//
// useOpenedTabs — the tabs opened so far. A panel mounts the first time its
// tab opens and then stays mounted while hidden, so switching back keeps what
// was on it (a check that is still running, a half-typed detail) and a tab
// that is never opened loads nothing.

import { useCallback, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import { DEFAULT_EDITOR_TAB, EDITOR_TAB_QUERY, editorTabFrom, withEditorTab, type EditorTab } from './tabs';

export interface EditorTabState {
  /** The tab the user chose (the editor falls back to Edit when it is not on offer). */
  tab: EditorTab;
  select: (next: EditorTab) => void;
}

export function useEditorTab(): EditorTabState {
  const params = useSearchParams();
  const router = useRouter();
  // usePathname() is `string | null` under Next's pages-router compat types (pages/ exists).
  const pathname = usePathname() ?? (typeof window !== 'undefined' ? window.location.pathname : '/');
  const query = params?.toString() ?? '';
  const fromUrl = editorTabFrom(params?.get(EDITOR_TAB_QUERY));

  const [tab, setTab] = useState<EditorTab>(fromUrl);
  // The URL moved by itself: follow it (state adjusted while rendering, so no stale frame).
  const [seenInUrl, setSeenInUrl] = useState<EditorTab>(fromUrl);
  if (seenInUrl !== fromUrl) {
    setSeenInUrl(fromUrl);
    setTab(fromUrl);
  }

  const select = useCallback(
    (next: EditorTab) => {
      // The open tab again: nothing changes, so the URL is not rewritten either.
      if (next === tab) return;
      setTab(next);
      const qs = withEditorTab(query, next);
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [pathname, query, router, tab],
  );

  return { tab, select };
}

export function useOpenedTabs(active: EditorTab): ReadonlySet<EditorTab> {
  const [opened, setOpened] = useState<ReadonlySet<EditorTab>>(() => new Set<EditorTab>([DEFAULT_EDITOR_TAB, active]));
  if (!opened.has(active)) setOpened(new Set([...opened, active]));
  return opened;
}
