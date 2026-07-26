'use client';

// Topbar — the sticky header (.topbar). Left: the page name. Right
// (.top-actions): the ⌘K search trigger, the theme toggle, the language
// switcher, and the AvatarMenu.
//
// The crumb is one level now. Two levels only ever said "Workspace / Today",
// and with four destinations the section half carried no information — it was
// the same word on five of six screens. CRUMB_MAP has an entry for every route
// the shell renders; an unmatched path renders NO crumb rather than silently
// falling back to "Workspace", which is how /plans, /account and /admin all
// used to breadcrumb as a section they were not in.
//
// The notification bell is gone. It had no feed behind it and no click
// handler — a control that cannot do anything is the same species of claim as
// the fabricated stat strip.
//
// Mobile: the topbar renders at every width, which is what makes the
// AvatarMenu (Settings / Billing / Sign out) reachable on a phone at all. The
// 240px search field collapses to an icon button below 760px so the row still
// fits on a 375px screen.

import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Fragment } from 'react';
import { useCommandPalette } from './CommandPalette';
import { AvatarMenu } from './AvatarMenu';
import { LanguageSwitcher } from './LanguageSwitcher';
import { ThemeToggle } from './ThemeToggle';
import { IconSearch } from '../primitives/Iconset';

/** Route prefix → key in the `nav` namespace. Most-specific prefix first;
 *  every route the (auth) shell renders has an entry. */
const CRUMB_MAP: { test: (p: string) => boolean; page: string }[] = [
  // /settings/billing/history is the invoice list — it belongs to Billing, and
  // must be tested before the plain /settings prefix.
  { test: (p) => p.startsWith('/settings/billing'), page: 'billing' },
  { test: (p) => p === '/settings' || p.startsWith('/settings/'), page: 'settings' },
  { test: (p) => p === '/jobs' || p.startsWith('/jobs/'), page: 'jobs' },
  { test: (p) => p === '/resume' || p.startsWith('/resume/'), page: 'resume' },
  { test: (p) => p === '/applications' || p.startsWith('/applications/'), page: 'applications' },
  { test: (p) => p === '/practice' || p.startsWith('/practice/'), page: 'practice' },
  { test: (p) => p === '/admin' || p.startsWith('/admin/'), page: 'admin' },
];

export function Topbar() {
  const pathname = usePathname() ?? '';
  const t = useTranslations('nav');
  const palette = useCommandPalette();

  const crumb = CRUMB_MAP.find((c) => c.test(pathname));
  const parts: string[] = crumb ? [t(crumb.page)] : [];

  return (
    <div className="topbar">
      <div className="crumbs">
        {parts.map((c, i, arr) => (
          <Fragment key={c}>
            <span className={i === arr.length - 1 ? 'now' : undefined}>{c}</span>
            {i < arr.length - 1 ? <span className="sep">/</span> : null}
          </Fragment>
        ))}
      </div>

      <div className="top-actions">
        <button
          type="button"
          className="search max-[760px]:hidden"
          onClick={palette.open}
          aria-label={t('search_aria')}
        >
          <IconSearch size={13} />
          <span className="grow">{t('search_placeholder')}</span>
          <kbd>⌘K</kbd>
        </button>

        {/* Same action, phone width. Two elements rather than one that reflows,
         *  because .search is a 240px input-shaped button and an icon button is
         *  a different control, not a narrower one. */}
        <button
          type="button"
          className="icon-btn hidden max-[760px]:grid"
          onClick={palette.open}
          aria-label={t('search_aria')}
        >
          <IconSearch size={15} />
        </button>

        <ThemeToggle />

        <LanguageSwitcher />

        <AvatarMenu />
      </div>
    </div>
  );
}
