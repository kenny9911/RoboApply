'use client';

// Sidebar — the 248px nav rail (.side). Top→bottom: BrandLogo, the top group
// of destinations, the lower group (Coaching, Invite friends, Get the
// extension, Settings, the plan badge, Admin), and — while the user is inside
// /settings — the Settings section list.
//
// The entries come from ONE registry, `destinations.ts` (PRODUCT_PLAN.md §3.3,
// per brand). The rail never decides on its own what exists: an entry shows
// only for its brand, when its page is ready, when its capability flag is on
// and when its gate (admin role, coach roster) passes. RoboApply today shows
// Jobs · Applications · Resume · Interview prep, then Settings (+ Admin);
// Ready to apply, Profile, Coaching, Invite friends and Get the extension
// appear as INT flips their `ready` bit.
//
// Badges are named by the entry and computed by the owning area's hook
// (hooks/shared/navBadges.ts). The rail draws what the hook returns and
// nothing for null; a zero is never drawn.
//
// While the user is inside /settings, a Settings group opens beneath the
// entries listing that page's sections (components/features/settings), so the
// screen has one rail, not a second one of its own.

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useAuth } from '../../../lib/auth/useAuth';
import { cn } from '../../../lib/utils';
import { useNavBadges, NAV_BADGE_LABEL_KEYS, type NavBadgeValue } from '../../../hooks/shared/navBadges';
import { SettingsRail } from '../../features/settings';
import { PlanBadge } from '../../features/credits/PlanBadge';
import { BrandLogo } from './BrandLogo';
import { buildNav, useVisibleNav, type NavEntry } from './destinations';
import styles from './shell.module.css';
import { IconFile, IconSearch, IconSparkle } from '../primitives/Iconset';

// Kept for existing importers: the tracker's no-reply count moved to the
// Applications badge hook, which owns it now.
export { countAwaitingReply } from '../../../hooks/tracker/useApplicationsBadge';

/** The legacy shape of a destination, still exported for older importers. */
export interface Destination {
  href: string;
  labelKey: string;
  Icon: NavEntry['icon'];
  match: (p: string) => boolean;
}

/**
 * The RoboApply bottom-bar destinations in the legacy `Destination` shape,
 * derived from the registry so the two can never disagree. Prefer
 * `useVisibleNav()`: this static list ignores the brand, flags and readiness.
 */
export const DESTINATIONS: Destination[] = buildNav({
  brandId: 'roboapply',
  flags: null,
  isAdmin: false,
  showAll: false,
  coachRoster: false,
}).mobile.map((e) => ({ href: e.href, labelKey: e.labelKey, Icon: e.icon, match: e.match }));

/** One rail link with its badge. Shared with the More sheet. */
export function NavBadge({ id, value }: { id: NonNullable<NavEntry['badge']>; value: NavBadgeValue | null }) {
  const t = useTranslations('nav');
  if (!value) return null;
  if (value.kind === 'dot') {
    return (
      <>
        <span className={styles.dot} aria-hidden="true" />
        <span className="sr-only">{t(NAV_BADGE_LABEL_KEYS[id])}</span>
      </>
    );
  }
  return (
    <>
      <span className="count" aria-hidden="true">
        {value.count}
      </span>
      {/* The bare number is unreadable out of context; screen readers get the sentence instead. */}
      <span className="sr-only">{t(NAV_BADGE_LABEL_KEYS[id], { count: value.count })}</span>
    </>
  );
}

export function Sidebar({ className }: { className?: string } = {}) {
  const pathname = usePathname() ?? '';
  const t = useTranslations('nav');
  const { user } = useAuth();
  const nav = useVisibleNav();
  const badges = useNavBadges();
  const inSettings = pathname === '/settings' || pathname.startsWith('/settings/');

  function renderLink(item: NavEntry) {
    // Inside /settings the section list carries the highlight; no entry is lit.
    const active = !inSettings && item.match(pathname);
    const badge = item.badge ? badges[item.badge] : null;
    const Icon = item.icon;
    return (
      <Link
        key={item.id}
        href={item.href}
        className={cn('nav-item', badge !== null && !active && 'notif')}
        aria-current={active ? 'page' : undefined}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
          <Icon size={15} />
          {t(item.labelKey)}
        </span>
        {item.badge ? <NavBadge id={item.badge} value={badge} /> : null}
      </Link>
    );
  }

  return (
    <aside className={cn('side', className)} aria-label={t('aria_primary')}>
      <BrandLogo />

      <div className="workspace-identity">
        <span className="workspace-avatar" aria-hidden="true">
          {user?.name?.trim().slice(0, 1).toUpperCase() || '·'}
        </span>
        <div>
          <strong>{t('workspace')}</strong>
          <span>{t('workspace_note')}</span>
        </div>
      </div>

      <nav className="nav">
        {nav.top.map(renderLink)}
        {nav.lower.length > 0 ? (
          <div className={cn('nav-group', styles.lower)} role="group" aria-label={t('aria_lower')}>
            {nav.lower.map(renderLink)}
          </div>
        ) : null}
        <PlanBadge variant="rail" />
        {inSettings ? <SettingsRail /> : null}
      </nav>

      <div className="workspace-guide">
        <div className="workspace-guide-path" aria-hidden="true">
          <IconSearch size={18} /><i /><IconFile size={18} /><i /><IconSparkle size={18} />
        </div>
        <strong>{t('guide')}</strong>
        <p>{t('guide_note')}</p>
      </div>
    </aside>
  );
}
