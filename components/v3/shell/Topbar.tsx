'use client';

// Topbar — the sticky header (.topbar). Left: breadcrumbs (mono uppercase,
// derived from the pathname). Right (.top-actions): the ⌘K search trigger (a
// button styled as an input that opens the CommandPalette), a notification
// bell with a glow badge, and the avatar monogram (gradient --grad-brand).
//
// Breadcrumbs come from a route→crumb map mirroring the prototype's `crumbs`
// table; the live (last) segment gets the `.now` highlight.

import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Fragment } from 'react';
import { useAuth } from '../../../lib/auth/AuthProvider';
import { useCommandPalette } from './CommandPalette';
import { LanguageSwitcher } from './LanguageSwitcher';
import { ThemeToggle } from './ThemeToggle';
import { IconSearch, IconBell } from '../primitives/Iconset';

// Route prefix → [sectionKey, pageKey] (keys into nav_v3). Order matters:
// longest/most-specific prefixes first.
const CRUMB_MAP: { test: (p: string) => boolean; section: string; page: string }[] = [
  { test: (p) => p.startsWith('/home'), section: 'section_workspace', page: 'today' },
  { test: (p) => p.startsWith('/queue'), section: 'section_workspace', page: 'queue' },
  { test: (p) => p.startsWith('/resumes'), section: 'section_workspace', page: 'resumes' },
  { test: (p) => p.startsWith('/mock-interview'), section: 'section_workspace', page: 'interview' },
  { test: (p) => p.startsWith('/tracker'), section: 'section_workspace', page: 'pipeline' },
  { test: (p) => p.startsWith('/activity'), section: 'section_workspace', page: 'activity' },
  { test: (p) => p.startsWith('/preferences'), section: 'section_settings', page: 'preferences' },
  { test: (p) => p.startsWith('/onboarding'), section: 'section_settings', page: 'onboarding' },
];

export function Topbar() {
  const pathname = usePathname() ?? '';
  const t = useTranslations('nav_v3');
  const { user } = useAuth();
  const palette = useCommandPalette();

  const crumb = CRUMB_MAP.find((c) => c.test(pathname));
  const parts: string[] = crumb
    ? [t(crumb.section), t(crumb.page)]
    : [t('section_workspace')];

  const monogram = (() => {
    const src = user?.name?.trim() || user?.email?.trim() || '';
    if (!src) return 'AA';
    const bits = src.split(/[\s@.]+/).filter(Boolean);
    if (bits.length >= 2) return (bits[0][0] + bits[1][0]).toUpperCase();
    return src.slice(0, 2).toUpperCase();
  })();

  return (
    <div className="topbar">
      <div className="crumbs">
        {parts.map((c, i, arr) => (
          <Fragment key={i}>
            <span className={i === arr.length - 1 ? 'now' : undefined}>{c}</span>
            {i < arr.length - 1 ? <span className="sep">/</span> : null}
          </Fragment>
        ))}
      </div>

      <div className="top-actions">
        <button
          type="button"
          className="search"
          onClick={palette.open}
          aria-label={t('search_aria')}
        >
          <IconSearch size={13} />
          <span className="grow">{t('search_placeholder')}</span>
          <kbd>⌘K</kbd>
        </button>

        <ThemeToggle />

        <LanguageSwitcher />

        <button type="button" className="icon-btn" aria-label={t('notifications')}>
          <IconBell size={15} />
          {/* Removed a hardcoded unread-glow badge (<span className="badge" />)
              that rendered unconditionally with no notifications feed behind it
              — it implied unread notifications to every user at all times. */}
        </button>

        <span className="avatar" aria-hidden="true">
          {monogram}
        </span>
      </div>
    </div>
  );
}
