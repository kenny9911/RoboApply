'use client';

// MobileNav — the V3 bottom bar for < md (the prototype is desktop-only; this
// is the small extra the design spec flags). Same Workspace IA as the sidebar,
// condensed to icon + label. Active item gets the accent treatment. The 248px
// grid sidebar is hidden below md by the (auth) layout; this takes its place.

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import {
  IconHome,
  IconList,
  IconFile,
  IconSparkle,
  IconStack,
} from '../primitives/Iconset';
import {
  QUEUE_REVIEW_ENABLED,
  useJobApplyingEnabled,
} from '../../../lib/jobApplying';

const ITEMS: { href: string; labelKey: string; icon: ReactNode; match: (p: string) => boolean; jobApply?: boolean }[] = [
  { href: '/home', labelKey: 'today', icon: <IconHome size={18} />, match: (p) => p === '/home' || p.startsWith('/home/'), jobApply: true },
  { href: '/queue', labelKey: 'queue', icon: <IconList size={18} />, match: (p) => p.startsWith('/queue'), jobApply: true },
  { href: '/resumes', labelKey: 'resumes', icon: <IconFile size={18} />, match: (p) => p.startsWith('/resumes') },
  { href: '/mock-interview', labelKey: 'interview', icon: <IconSparkle size={18} />, match: (p) => p.startsWith('/mock-interview') },
  { href: '/tracker', labelKey: 'tracker', icon: <IconStack size={18} />, match: (p) => p.startsWith('/tracker'), jobApply: true },
];

export function MobileNav() {
  const pathname = usePathname() ?? '';
  const t = useTranslations('nav_v3');
  // Hide the auto-apply tabs unless job-applying is known to be enabled.
  const showJobApply = useJobApplyingEnabled() === true;
  const items = (showJobApply ? ITEMS : ITEMS.filter((i) => !i.jobApply)).filter(
    (i) => QUEUE_REVIEW_ENABLED || i.href !== '/queue',
  );

  return (
    <nav
      aria-label="Mobile"
      className="v3-mobile-nav robo-bottom-nav fixed inset-x-0 bottom-0 z-30 items-stretch"
      style={{
        background: 'var(--bg-2)',
        borderTop: '1px solid var(--rule)',
      }}
    >
      {items.map((item) => {
        const active = item.match(pathname);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className="flex flex-1 flex-col items-center justify-center gap-1 py-2.5"
            style={{ color: active ? 'var(--accent-text)' : 'var(--muted)' }}
          >
            {item.icon}
            <span
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 9,
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                fontWeight: 600,
              }}
            >
              {t(item.labelKey)}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}
