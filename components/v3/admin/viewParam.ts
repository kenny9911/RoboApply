'use client';

// The `?view=` tab of an admin page, kept in the URL so a view is linkable
// (e.g. /admin/system?view=feedback). Read once on mount (no Suspense
// boundary needed), written with replaceState.

import { useCallback, useEffect, useState } from 'react';

export function useViewParam<T extends string>(views: readonly T[], fallback: T): [T, (next: T) => void] {
  const [view, setView] = useState<T>(fallback);
  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get('view') as T | null;
    if (requested && views.includes(requested)) setView(requested);
    // Views are a static list per page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const change = useCallback((next: T) => {
    setView(next);
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('view', next);
      window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}`);
    } catch {
      // URL sync is a convenience only.
    }
  }, []);
  return [view, change];
}
