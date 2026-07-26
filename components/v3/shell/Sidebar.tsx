'use client';

// Sidebar — the 248px V3 nav rail (.side). Top→bottom: BrandLogo, then the
// primary nav (6 Workspace items + a Settings group). Every entry is a link;
// the two button-shaped Settings actions (Tweaks, Replay onboarding) are gone
// — Tweaks opened the deleted accent/density/tone panel, and onboarding replay
// was a hard nav to /onboarding nobody asked for from the rail.
//
// IA from docs/roboapply/v3/01-ia-and-routes.md §1 + the prototype app.jsx:
//   Workspace: Today /home · Review queue /queue · Resume builder /resumes ·
//              Mock interview /mock-interview (NEW) · Pipeline /tracker ·
//              Activity log /activity
//   Settings:  Preferences /preferences · Plans /plans · Account /account
//
// Active-state: exact match, or prefix match for routes with sub-routes
// (/resumes/[id] lights Resume builder; /mock-interview/[id] lights Mock
// interview). Badges (Wave 3): /queue shows the live pendingCount from
// useQueue(); /home shows matchedAboveThreshold from the shared orbStats
// query. Both hide at 0. /mock-interview keeps a static translated "NEW" pill.

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { useQueue } from '../../../hooks/useQueue';
import { useAgentStats } from '../../../hooks/useActivity';
import { useAuth } from '../../../lib/auth/useAuth';
import {
  QUEUE_REVIEW_ENABLED,
  useJobApplyingEnabled,
} from '../../../lib/jobApplying';
import { cn } from '../../../lib/utils';
import { BrandLogo } from './BrandLogo';
import {
  IconHome,
  IconList,
  IconFile,
  IconSparkle,
  IconStack,
  IconClock,
  IconSettings,
  IconBolt,
} from '../primitives/Iconset';

/** Badge sources. 'queue' / 'today-new' are live counts (hidden when 0);
 *  'new' is the static translated NEW pill. */
type NavBadge = 'queue' | 'today-new' | 'new';

interface NavLink {
  kind: 'link';
  href: string;
  labelKey: string;
  icon: ReactNode;
  match: (p: string) => boolean;
  /** Badge at the right edge. Omit for no badge. */
  badge?: NavBadge;
  /** Glowing notif treatment when not active (live badges also need count > 0). */
  notif?: boolean;
  /** Part of the auto-apply surface — hidden when JOB_APPLYING_ENABLED is off. */
  jobApply?: boolean;
}

const WORKSPACE: NavLink[] = [
  {
    kind: 'link',
    href: '/home',
    labelKey: 'today',
    icon: <IconHome size={15} />,
    match: (p) => p === '/home' || p.startsWith('/home/'),
    badge: 'today-new',
    notif: true,
    jobApply: true,
  },
  {
    kind: 'link',
    href: '/queue',
    labelKey: 'queue',
    icon: <IconList size={15} />,
    match: (p) => p === '/queue' || p.startsWith('/queue/'),
    badge: 'queue',
    notif: true,
    jobApply: true,
  },
  {
    kind: 'link',
    href: '/resumes',
    labelKey: 'resumes',
    icon: <IconFile size={15} />,
    match: (p) => p === '/resumes' || p.startsWith('/resumes/'),
  },
  {
    kind: 'link',
    href: '/mock-interview',
    labelKey: 'interview',
    icon: <IconSparkle size={15} />,
    match: (p) => p === '/mock-interview' || p.startsWith('/mock-interview/'),
    badge: 'new',
    notif: true,
  },
  {
    kind: 'link',
    href: '/tracker',
    labelKey: 'pipeline',
    icon: <IconStack size={15} />,
    match: (p) => p === '/tracker' || p.startsWith('/tracker/'),
    jobApply: true,
  },
  {
    kind: 'link',
    href: '/activity',
    labelKey: 'activity',
    icon: <IconClock size={15} />,
    match: (p) => p === '/activity' || p.startsWith('/activity/'),
    jobApply: true,
  },
];

const SETTINGS: NavLink[] = [
  {
    kind: 'link',
    href: '/preferences',
    labelKey: 'preferences',
    icon: <IconSettings size={15} />,
    match: (p) => p === '/preferences' || p.startsWith('/preferences/'),
  },
  {
    // Subscription plans + mock-interview credits. Not job-apply-gated — the
    // mock-interview product (and its billing) is available with auto-apply off.
    kind: 'link',
    href: '/plans',
    labelKey: 'plans',
    icon: <IconBolt size={15} />,
    match: (p) => p === '/plans' || p.startsWith('/plans/'),
  },
  {
    kind: 'link',
    href: '/account',
    labelKey: 'account',
    icon: <IconFile size={15} />,
    match: (p) => p === '/account' || p.startsWith('/account/'),
  },
];

/** Admin-only entry, rendered after the Settings group when role === 'admin'. */
const ADMIN_LINK: NavLink = {
  kind: 'link',
  href: '/admin',
  labelKey: 'admin',
  icon: <IconBolt size={15} />,
  match: (p) => p === '/admin' || p.startsWith('/admin/'),
};

export function Sidebar({ className }: { className?: string } = {}) {
  const pathname = usePathname() ?? '';
  const t = useTranslations('nav_v3');
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  // Master switch: hide the auto-apply surface (Today/Queue/Pipeline/Activity)
  // unless we positively know job-applying is enabled. Treating `null` (still
  // loading) as "hide" avoids flashing those items in a disabled deploy.
  const showJobApply = useJobApplyingEnabled() === true;
  const workspace = (
    showJobApply ? WORKSPACE : WORKSPACE.filter((i) => !i.jobApply)
  ).filter((i) => QUEUE_REVIEW_ENABLED || i.href !== '/queue');
  const settings = showJobApply ? SETTINGS : SETTINGS.filter((i) => !i.jobApply);

  // Live badge counts. useQueue shares its cache with the /queue page (locale
  // is part of the key); useAgentStats shares with Today / Activity /
  // Preferences, so neither adds a request beyond what the rail already makes.
  // The queue fetch is suppressed entirely while the surface is hidden for
  // launch.
  const { data: queueData } = useQueue({ enabled: QUEUE_REVIEW_ENABLED });
  const { data: statsData } = useAgentStats();
  const queuePending = queueData?.pendingCount ?? 0;
  const todayNew = statsData?.stats.matchedAboveThreshold ?? 0;

  function badgeText(badge: NavBadge | undefined): string | null {
    switch (badge) {
      case 'queue':
        return queuePending > 0 ? String(queuePending) : null;
      case 'today-new':
        return todayNew > 0 ? t('badge_new_count', { count: todayNew }) : null;
      case 'new':
        return t('badge_new');
      default:
        return null;
    }
  }

  function renderLink(item: NavLink) {
    const active = item.match(pathname);
    const badge = badgeText(item.badge);
    // Live badges only glow while they actually have something to show.
    const liveBadge = item.badge === 'queue' || item.badge === 'today-new';
    const notif = item.notif && (!liveBadge || badge !== null);
    return (
      <Link
        href={item.href}
        className={cn('nav-item', notif && !active && 'notif')}
        aria-current={active ? 'page' : undefined}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
          {item.icon}
          {t(item.labelKey)}
        </span>
        {badge ? <span className="count">{badge}</span> : null}
      </Link>
    );
  }

  return (
    <aside className={cn('side', className)} aria-label="Primary">
      <BrandLogo />

      <nav className="nav">
        <div className="nav-section">{t('section_workspace')}</div>
        {workspace.map((item) => (
          <div key={item.href}>{renderLink(item)}</div>
        ))}
        <div className="nav-section">{t('section_settings')}</div>
        {settings.map((item) => (
          <div key={item.href}>{renderLink(item)}</div>
        ))}
        {isAdmin ? <div key={ADMIN_LINK.href}>{renderLink(ADMIN_LINK)}</div> : null}
      </nav>
    </aside>
  );
}
