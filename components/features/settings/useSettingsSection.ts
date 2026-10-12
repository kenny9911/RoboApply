'use client';

// components/features/settings/useSettingsSection.ts — which /settings
// section is open (FND-6a). The section is the URL hash (`/settings#billing`),
// so the page's section row, the Sidebar's Settings group and every deep link
// agree without sharing React state.
//
// One subscription, three change channels (same as the pre-clone hook in
// hooks/useSettingsSection.ts, which stays for its existing importers):
//   1. `hashchange` / `popstate` — a fragment anchor click, a back button;
//   2. a re-render reads window.location again;
//   3. Next's own navigation (`<Link href="/settings#billing">`) writes the
//      URL with pushState after the render that reacted to it, so an effect
//      keyed on pathname + search params re-checks.

import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';

import { useBrand } from '../../../lib/brand/BrandProvider';
import { useCapabilities } from '../../../lib/flags';
import { showAllNav } from '../../v3/shell/destinations';
import {
  sectionIdFromHash,
  visibleSettingsSections,
  type SettingsSectionEntry,
  type SettingsSectionId,
} from './registry';

/**
 * Pure: the open section for a (pathname, hash) among the visible sections.
 * /settings/billing/* is the invoice list hanging off billing; an unknown,
 * hidden or empty hash opens the first visible section.
 */
export function activeSectionFor(
  pathname: string,
  hash: string,
  visible: readonly SettingsSectionId[],
): SettingsSectionId | null {
  if (pathname.startsWith('/settings/billing') && visible.includes('billing')) return 'billing';
  const id = sectionIdFromHash(hash);
  if (id && visible.includes(id)) return id;
  return visible[0] ?? null;
}

const listeners = new Set<() => void>();
function notifyAll(): void {
  for (const l of [...listeners]) l();
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
const readHash = () => window.location.hash;
const serverHash = () => '';

/** The sections visible for the current brand and flags. */
export function useVisibleSettingsSections(): SettingsSectionEntry[] {
  const brand = useBrand();
  const { flags } = useCapabilities();
  const showAll = showAllNav();
  return useMemo(
    () => visibleSettingsSections({ brandId: brand.id, flags, showAll }),
    [brand.id, flags, showAll],
  );
}

/** The open section among the visible ones (null only when none is visible). */
export function useActiveSettingsSection(visible: readonly SettingsSectionEntry[]): SettingsSectionId | null {
  const pathname = usePathname() ?? '';
  const searchParams = useSearchParams();
  const hash = useSyncExternalStore(subscribe, readHash, serverHash);
  useEffect(() => {
    notifyAll();
  }, [pathname, searchParams]);
  const ids = useMemo(() => visible.map((s) => s.id), [visible]);
  return activeSectionFor(pathname, hash, ids);
}

/** Tests: re-read the URL after a pushState the way Next does. */
export function syncSettingsSectionHash(): void {
  notifyAll();
}
