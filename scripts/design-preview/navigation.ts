import { useMemo, useSyncExternalStore } from 'react';

const listeners = new Set<() => void>();
let revision = 0;
function publish() { revision++; for (const listener of listeners) listener(); }
window.addEventListener('popstate', publish);
window.addEventListener('hashchange', publish);
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
function snapshot() { return `${window.location.href}|${revision}`; }
export function usePreviewLocation() { return useSyncExternalStore(subscribe, snapshot, snapshot); }

export function navigate(href: string, replace = false) {
  const url = new URL(href, window.location.href);
  if (url.origin !== window.location.origin) return;
  window.history[replace ? 'replaceState' : 'pushState'](null, '', url);
  publish();
  if (url.hash) document.getElementById(url.hash.slice(1))?.scrollIntoView();
  else window.scrollTo(0, 0);
}
const router = {
  push: (href: string) => navigate(href),
  replace: (href: string) => navigate(href, true),
  refresh: publish,
  back: () => window.history.back(),
  forward: () => window.history.forward(),
  prefetch: () => {},
};
export function useRouter() { return router; }
export function usePathname() { usePreviewLocation(); return window.location.pathname; }
export function useSearchParams() {
  const location = usePreviewLocation();
  return useMemo(() => new URLSearchParams(window.location.search), [location]);
}
export function useParams() {
  const path = usePathname();
  return useMemo(() => ({ id: path.split('/')[2] ?? '' }), [path]);
}
