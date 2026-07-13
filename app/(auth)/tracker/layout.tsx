'use client';

// /tracker layout — hosts the two "Tracker" tabs that used to be separate
// sidebar items:
//   • /tracker           → the pipeline board (进度看板)
//   • /tracker/activity  → the agent activity log (活动记录)
//
// The tab strip is a thin route-based segmented control (mono labels + accent
// underline, matching admin/controls.tsx TabRail) rendered above each tab's
// own PageHeader. The two surfaces stay backed by their own data (RATrackerEntry
// vs the auto-apply RoboApplyRun history) — this is an IA merge, not a data one.

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';

const TABS: { href: string; labelKey: string; match: (p: string) => boolean }[] = [
  {
    href: '/tracker',
    labelKey: 'pipeline',
    match: (p) => p === '/tracker',
  },
  {
    href: '/tracker/activity',
    labelKey: 'activity',
    match: (p) => p === '/tracker/activity' || p.startsWith('/tracker/activity/'),
  },
];

export default function TrackerLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? '';
  const t = useTranslations('nav_v3');

  return (
    <>
      <div
        role="tablist"
        aria-label={t('tracker')}
        style={{
          display: 'flex',
          gap: 4,
          borderBottom: '1px solid var(--rule)',
          marginBottom: 28,
          overflowX: 'auto',
        }}
      >
        {TABS.map((tab) => {
          const on = tab.match(pathname);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              role="tab"
              aria-selected={on}
              aria-current={on ? 'page' : undefined}
              style={{
                fontFamily: 'var(--mono)',
                fontSize: '12px',
                fontWeight: 600,
                letterSpacing: '0.04em',
                textTransform: 'uppercase',
                color: on ? 'var(--text)' : 'var(--muted)',
                textDecoration: 'none',
                padding: '12px 16px',
                whiteSpace: 'nowrap',
                boxShadow: on ? 'inset 0 -2px 0 var(--accent)' : 'none',
              }}
            >
              {t(tab.labelKey)}
            </Link>
          );
        })}
      </div>

      {children}
    </>
  );
}
