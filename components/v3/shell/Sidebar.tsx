'use client';

// Sidebar — the 248px V3 nav rail (.side). Top→bottom: BrandLogo, the primary
// nav (6 Workspace items + a Settings group), then the agent OrbCard pinned to
// the bottom. The Tweaks panel + onboarding replay are surfaced as Settings
// items (the prototype's `app.jsx` does the same).
//
// IA from docs/roboapply/v3/01-ia-and-routes.md §1 + the prototype app.jsx:
//   Workspace: Today /home · Review queue /queue · Resume builder /resumes ·
//              Mock interview /mock-interview (NEW) · Tracker /tracker
//              (board + activity log as two tabs)
//   Settings:  Replay onboarding · Tweaks (admin-only) · Preferences
//              /preferences
//
// Active-state: exact match, or prefix match for routes with sub-routes
// (/resumes/[id] lights Resume builder; /mock-interview/[id] lights Mock
// interview). Badges (Wave 3): /queue shows the live pendingCount from
// useQueue(); /home shows matchedAboveThreshold from the orbStats query the
// OrbCard below already keeps warm (so it costs no extra request). Both hide
// at 0. /mock-interview keeps a static translated "NEW" pill.

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState, type ReactNode } from 'react';
import { useQueue } from '../../../hooks/useQueue';
import { useAgentStats } from '../../../hooks/useActivity';
import { useAuth } from '../../../lib/auth/useAuth';
import {
  QUEUE_REVIEW_ENABLED,
  useJobApplyingEnabled,
} from '../../../lib/jobApplying';
import { cn } from '../../../lib/utils';
import { BrandLogo } from './BrandLogo';
import { OrbCard } from './OrbCard';
import { TweaksPanel } from '../../dc/TweaksPanel';
import {
  IconHome,
  IconList,
  IconFile,
  IconSparkle,
  IconStack,
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
interface NavAction {
  kind: 'action';
  id: 'tweaks' | 'replay-onboarding';
  labelKey: string;
  icon: ReactNode;
  /** Part of the auto-apply surface — hidden when JOB_APPLYING_ENABLED is off. */
  jobApply?: boolean;
}
type NavEntry = NavLink | NavAction;

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
    // Umbrella "Tracker" entry — the /tracker page hosts two tabs: the pipeline
    // board (进度看板) and the agent activity log (活动记录, /tracker/activity).
    // Folds what used to be two separate sidebar items into one.
    kind: 'link',
    href: '/tracker',
    labelKey: 'tracker',
    icon: <IconStack size={15} />,
    match: (p) => p === '/tracker' || p.startsWith('/tracker/'),
    jobApply: true,
  },
];

const SETTINGS: NavEntry[] = [
  {
    kind: 'action',
    id: 'replay-onboarding',
    labelKey: 'replay_onboarding',
    icon: <IconSparkle size={15} />,
    jobApply: true,
  },
  { kind: 'action', id: 'tweaks', labelKey: 'tweaks', icon: <IconSettings size={15} />, jobApply: true },
  {
    kind: 'link',
    href: '/preferences',
    labelKey: 'preferences',
    icon: <IconSettings size={15} />,
    match: (p) => p === '/preferences' || p.startsWith('/preferences/'),
  },
  {
    // Unified Account area — profile, plans/upgrade, billing, orders & invoices,
    // usage, and security all live here as tabs (folds in the old /plans entry).
    // Not job-apply-gated: the mock-interview product + its billing are
    // available with auto-apply off.
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
  const [tweaksOpen, setTweaksOpen] = useState(false);

  // Master switch: hide the auto-apply surface (Today/Queue/Pipeline/Activity +
  // Replay onboarding/Tweaks + the agent orb) unless we positively know
  // job-applying is enabled. Treating `null` (still loading) as "hide" avoids
  // flashing those items in a disabled deploy.
  const showJobApply = useJobApplyingEnabled() === true;
  const workspace = (
    showJobApply ? WORKSPACE : WORKSPACE.filter((i) => !i.jobApply)
  ).filter((i) => QUEUE_REVIEW_ENABLED || i.href !== '/queue');
  const settings = (showJobApply ? SETTINGS : SETTINGS.filter((i) => !i.jobApply))
    // 偏好微调 (Tweaks) is an admin-only affordance — regular seekers never see it.
    .filter((i) => isAdmin || i.kind !== 'action' || i.id !== 'tweaks');

  // Live badge counts. useQueue shares its cache with the /queue page (locale
  // is part of the key); useAgentStats shares with the OrbCard below, so
  // neither adds a request beyond what the rail already makes. The queue fetch
  // is suppressed entirely while the surface is hidden for launch.
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

  function replayOnboarding() {
    if (typeof window === 'undefined') return;
    // Onboarding completion is tracked server-side (onboardingState.completedSteps
    // from /auth/me); the /onboarding route renders its flow unconditionally, so
    // replaying just means navigating there. Hard nav guarantees a clean remount.
    window.location.href = '/onboarding';
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

  function renderAction(item: NavAction) {
    return (
      <button
        type="button"
        className="nav-item"
        onClick={item.id === 'tweaks' ? () => setTweaksOpen(true) : replayOnboarding}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
          {item.icon}
          {t(item.labelKey)}
        </span>
      </button>
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
        {settings.map((item) =>
          item.kind === 'link' ? (
            <div key={item.href}>{renderLink(item)}</div>
          ) : (
            <div key={item.id}>{renderAction(item)}</div>
          ),
        )}
        {isAdmin ? <div key={ADMIN_LINK.href}>{renderLink(ADMIN_LINK)}</div> : null}
      </nav>

      {/* The agent orb summarizes auto-apply activity — hidden with the rest of
       *  the job-applying surface. */}
      {showJobApply ? <OrbCard /> : null}

      <TweaksPanel open={tweaksOpen} onClose={() => setTweaksOpen(false)} />
    </aside>
  );
}
