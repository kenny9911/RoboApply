'use client';

// hooks/useSettingsSection.ts
//
// /settings is ONE page with seven sections (ruling D2 — Settings is not a
// destination). Which section is open is the URL hash: /settings#billing.
//
// That makes the section a link target rather than component state, which is
// what lets three things agree without sharing React state:
//   • the app Sidebar's Settings group (components/v3/shell/SettingsRailGroup)
//   • the phone-only section row on the page itself
//   • every deep link in the product — the avatar menu's "Billing", the
//     practice launcher's "Get credits", the invoice page's back link. All
//     three already pointed at /settings#billing; before this hook existed the
//     page never read the hash, so each of them landed on "Your search".
//
// SETTINGS_SECTIONS is the single list both rails render from, in order.
//
// One subscription, three change channels:
//   1. `hashchange` / `popstate` — a fragment anchor click, a back button.
//   2. React re-render — `getSnapshot` reads window.location on every render,
//      so anything that re-renders the subscriber after the URL moved is
//      enough.
//   3. Next's own navigation — <Link href="/settings#billing"> from the avatar
//      menu updates the URL with pushState (no hashchange event) AFTER the
//      render that reacted to it. `useSearchParams()` is rebuilt from Next's
//      canonicalUrl, which includes the hash, so keying an effect on it and
//      re-checking the snapshot there closes that gap.

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';

export type SettingsSectionId =
  | 'search'
  | 'resume'
  | 'notif'
  | 'appearance'
  | 'billing'
  | 'account'
  | 'danger';

/** The seven sections, in rail order. `danger` tints the entry. */
export const SETTINGS_SECTIONS: ReadonlyArray<{ id: SettingsSectionId; danger?: boolean }> = [
  { id: 'search' },
  { id: 'resume' },
  { id: 'notif' },
  { id: 'appearance' },
  { id: 'billing' },
  { id: 'account' },
  { id: 'danger', danger: true },
];

export const DEFAULT_SETTINGS_SECTION: SettingsSectionId = 'search';

const IDS = new Set<string>(SETTINGS_SECTIONS.map((s) => s.id));

export function isSettingsSectionId(value: string): value is SettingsSectionId {
  return IDS.has(value);
}

/** Absolute href for a section — valid from any route, including
 *  /settings/billing/history. */
export function settingsSectionHref(id: SettingsSectionId): string {
  return `/settings#${id}`;
}

/**
 * Pure: which section a (pathname, hash) pair means. /settings/billing/* is
 * the invoice detail hanging off "Plan and billing", so that section stays lit
 * there; an unknown or empty hash is the first section.
 */
export function sectionFromLocation(pathname: string, hash: string): SettingsSectionId {
  if (pathname.startsWith('/settings/billing')) return 'billing';
  const id = hash.replace(/^#/, '');
  return isSettingsSectionId(id) ? id : DEFAULT_SETTINGS_SECTION;
}

// ── The store: window.location, with one listener set per document ─────────

const listeners = new Set<() => void>();

function notifyAll(): void {
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    window.addEventListener('hashchange', notifyAll);
    window.addEventListener('popstate', notifyAll);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      window.removeEventListener('hashchange', notifyAll);
      window.removeEventListener('popstate', notifyAll);
    }
  };
}

/**
 * Re-read the URL and re-render every subscriber whose section changed. Used
 * after a Next navigation (see channel 3 above); exported so tests can drive
 * a pushState the way Next does.
 */
export function syncSettingsSection(): void {
  notifyAll();
}

export function useSettingsSection(): SettingsSectionId {
  const pathname = usePathname() ?? '';
  const searchParams = useSearchParams();

  const getSnapshot = useCallback(
    () => sectionFromLocation(window.location.pathname, window.location.hash),
    [],
  );
  // Server render and the hydration pass have no hash; the pathname rule
  // still applies (/settings/billing/history → billing on the first paint).
  const getServerSnapshot = useCallback(() => sectionFromLocation(pathname, ''), [pathname]);

  const section = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  // Channel 3: Next committed a navigation (pathname and/or hash). The URL
  // was written during that commit, after our render read it — check again.
  useEffect(() => {
    notifyAll();
  }, [pathname, searchParams]);

  return section;
}
