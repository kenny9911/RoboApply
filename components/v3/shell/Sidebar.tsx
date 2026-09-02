'use client';

// Sidebar — the 248px nav rail (.side). Top→bottom: BrandLogo, then ONE nav
// group of four destinations, then the admin entry for role === 'admin'.
//
// IA per ruling R1/D2/D3 + C14. Four destinations, each named for the question
// the user says out loud:
//
//   /jobs          Jobs            "what should I apply to?"
//   /resume        Resume          "is my resume good enough?"
//   /applications  Applications    "where did I apply, and what happened?"
//   /practice      Interview prep  "am I ready to talk to them?"
//
// The Workspace / Settings section headers are gone: with four items there is
// nothing to file, and the two headers were 40% of the rail's vocabulary.
// Settings, Billing and Sign out moved to the AvatarMenu in the Topbar, which
// is the only place they were ever reachable on a phone.
//
// While the user is inside /settings, a Settings group opens beneath the
// destinations listing that page's seven sections (SettingsRailGroup) — so the
// screen has one rail, not a second one of its own. It is contextual, not a
// fifth destination: absent everywhere else, and never on the mobile bar.
//
// DESTINATIONS is exported and consumed by MobileNav, because the mobile bar
// IS the IA (D3): same four, same labels, same order, by construction rather
// than by two lists agreeing today and drifting next month.
//
// Deleted here: /home (Today), /queue (Review queue), /tracker (Pipeline),
// /activity (Activity log), /preferences, /plans, /account, the static "NEW"
// pill on mock interview, and the JOB_APPLYING_ENABLED filtering that hid half
// the rail — auto-apply is dead (R1), so there is no surface left to gate.

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useMemo, type ComponentType } from 'react';
import { useAuth } from '../../../lib/auth/useAuth';
import { usePipelineBoard } from '../../../hooks/usePipelineBoard';
import type { RATrackerEntryView } from '../../../lib/api/v2';
import { cn } from '../../../lib/utils';
import { BrandLogo } from './BrandLogo';
import { SettingsRailGroup } from './SettingsRailGroup';
import {
  IconSearch,
  IconFile,
  IconStack,
  IconSparkle,
  IconBolt,
  type IconProps,
} from '../primitives/Iconset';

export interface Destination {
  href: string;
  /** Key into the `nav` namespace. Route, nav label and namespace share a name. */
  labelKey: string;
  Icon: ComponentType<IconProps>;
  match: (p: string) => boolean;
}

/** The IA. Order is the order on both the rail and the mobile bar. */
export const DESTINATIONS: Destination[] = [
  {
    href: '/jobs',
    labelKey: 'jobs',
    Icon: IconSearch,
    match: (p) => p === '/jobs' || p.startsWith('/jobs/'),
  },
  {
    href: '/resume',
    labelKey: 'resume',
    Icon: IconFile,
    match: (p) => p === '/resume' || p.startsWith('/resume/'),
  },
  {
    href: '/applications',
    labelKey: 'applications',
    Icon: IconStack,
    match: (p) => p === '/applications' || p.startsWith('/applications/'),
  },
  {
    href: '/practice',
    labelKey: 'practice',
    Icon: IconSparkle,
    match: (p) => p === '/practice' || p.startsWith('/practice/'),
  },
];

/** Admin-only entry, rendered after the four destinations. Not a destination —
 *  it is a separate tool, and it never appears on the mobile bar. */
const ADMIN: Destination = {
  href: '/admin',
  labelKey: 'admin',
  Icon: IconBolt,
  match: (p) => p === '/admin' || p.startsWith('/admin/'),
};

/** Ruling C11: the one number worth interrupting someone for. */
const NO_REPLY_DAYS = 10;

/**
 * How many applications have had no reply in 10+ days.
 *
 * There is no reply event in the data model — nothing writes "they emailed
 * back". What the tracker does record is the stage the user last moved a row
 * to, so an entry still sitting in `applied` N days after `dateApplied` is one
 * nobody has heard from. Any real reply (a call, a rejection, an offer) moves
 * the row out of `applied` and out of this count. This is the same derivation
 * C38 sanctions for the row on /applications ("computed from tracker rows"),
 * and the two must not drift — see the handoff note about hoisting it into a
 * shared hook once /applications renders its own follow-up row.
 */
export function countAwaitingReply(
  entries: readonly RATrackerEntryView[],
  now: number = Date.now(),
): number {
  const cutoff = now - NO_REPLY_DAYS * 24 * 60 * 60 * 1000;
  return entries.filter(
    (e) =>
      e.status === 'applied' &&
      e.dateApplied !== null &&
      Date.parse(e.dateApplied) <= cutoff,
  ).length;
}

export function Sidebar({ className }: { className?: string } = {}) {
  const pathname = usePathname() ?? '';
  const t = useTranslations('nav');
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const inSettings = pathname === '/settings' || pathname.startsWith('/settings/');

  // Shares the TanStack cache entry with /applications and PipelineBoard, so
  // on the Applications screen the badge costs nothing and everywhere else it
  // is one read the user is about to need anyway.
  const { data: board } = usePipelineBoard();
  const noReply = useMemo(
    () => countAwaitingReply(board?.entries ?? []),
    [board],
  );

  function renderLink(item: Destination) {
    const active = item.match(pathname);
    // The only badge in the rail. Hidden at 0 — a zero badge is decoration.
    const badge = item.href === '/applications' && noReply > 0 ? noReply : null;
    const { Icon } = item;
    return (
      <Link
        key={item.href}
        href={item.href}
        className={cn('nav-item', badge !== null && !active && 'notif')}
        aria-current={active ? 'page' : undefined}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
          <Icon size={15} />
          {t(item.labelKey)}
        </span>
        {badge !== null ? (
          <>
            <span className="count" aria-hidden="true">
              {badge}
            </span>
            {/* The bare number is unreadable out of context; screen readers get
             *  the sentence instead. */}
            <span className="sr-only">
              {t('badge_no_reply', { count: badge })}
            </span>
          </>
        ) : null}
      </Link>
    );
  }

  return (
    <aside className={cn('side', className)} aria-label={t('aria_primary')}>
      <BrandLogo />

      <nav className="nav">
        {DESTINATIONS.map(renderLink)}
        {isAdmin ? renderLink(ADMIN) : null}
        {inSettings ? <SettingsRailGroup /> : null}
      </nav>
    </aside>
  );
}
