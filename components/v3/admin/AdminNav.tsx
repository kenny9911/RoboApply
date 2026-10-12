'use client';

// components/v3/admin/AdminNav.tsx — navigation to every admin area (WP-74).
//
// `ADMIN_AREAS` is the one list of admin sub-routes, built by their owning
// WPs: System and Reports to review (WP-74), Credits (WP-21b), Announcements
// (WP-61, the "What's new" admin entry), Practice questions (WP-59), Coaches
// (WP-72), job sources and company job boards (WP-42; both brands since the
// parity wave: each brand's admin sees its own sources), held invite rewards
// (WP-60's review routes; the page is /admin/reports/invites), and GoApply's
// campus calendar (WP-58), suspicious jobs (WP-41) and invite codes (WP-11).
// An area that belongs to one brand shows only on that brand's host. Admins see every area of their
// brand whether or not its feature flag is on, so they can prepare it.
//
//   <AdminNav variant="grid" />   the admin home: one card per area
//   <AdminNav variant="bar" />    sub-pages: a compact row with the current page marked

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useBrandId } from '../../../lib/brand/BrandProvider';
import styles from './console.module.css';

type BrandId = 'roboapply' | 'goapply';

export interface AdminArea {
  id: string;
  href: string;
  /** Brands whose admins see it; omitted = both. */
  brands?: readonly BrandId[];
  owner: string;
}

export const ADMIN_AREAS: readonly AdminArea[] = [
  { id: 'overview', href: '/admin', owner: 'WP-74' },
  { id: 'system', href: '/admin/system', owner: 'WP-74' },
  { id: 'reports', href: '/admin/reports', owner: 'WP-74' },
  { id: 'inviteRewards', href: '/admin/reports/invites', owner: 'WP-60' },
  { id: 'credits', href: '/admin/credits', owner: 'WP-21b' },
  { id: 'announcements', href: '/admin/announcements', owner: 'WP-61' },
  { id: 'questions', href: '/admin/questions', owner: 'WP-59' },
  { id: 'coaches', href: '/admin/coaches', owner: 'WP-72' },
  { id: 'sources', href: '/admin/sources', owner: 'WP-42' },
  { id: 'campus', href: '/admin/campus', brands: ['goapply'], owner: 'WP-58' },
  { id: 'fraud', href: '/admin/fraud', brands: ['goapply'], owner: 'WP-41' },
  { id: 'invites', href: '/admin/invites', brands: ['goapply'], owner: 'WP-11' },
];

export function adminAreasFor(brand: BrandId): AdminArea[] {
  return ADMIN_AREAS.filter((a) => !a.brands || a.brands.includes(brand));
}

/**
 * The area the path belongs to: the longest href that is the path or a parent
 * of it, so /admin/reports/invites marks "Held invite rewards", not "Reports
 * to review" as well.
 */
export function currentAdminArea(pathname: string, areas: readonly AdminArea[]): AdminArea | null {
  let best: AdminArea | null = null;
  for (const a of areas) {
    const hit = a.href === '/admin' ? pathname === '/admin' : pathname === a.href || pathname.startsWith(`${a.href}/`);
    if (hit && (!best || a.href.length > best.href.length)) best = a;
  }
  return best;
}

export function AdminNav({ variant = 'bar' }: { variant?: 'grid' | 'bar' }) {
  return variant === 'grid' ? <AdminAreasGrid /> : <AdminNavBar />;
}

function AdminAreasGrid() {
  const t = useTranslations('admin.console.nav');
  const areas = adminAreasFor(useBrandId()).filter((a) => a.id !== 'overview');
  return (
    <nav aria-label={t('label')}>
      <ul className={styles.areas}>
        {areas.map((a) => (
          <li key={a.id}>
            <Link className={styles.area} href={a.href}>
              <strong>{t(`${a.id}.title`)}</strong>
              <span>{t(`${a.id}.sub`)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function AdminNavBar() {
  const t = useTranslations('admin.console.nav');
  const pathname = usePathname() ?? '';
  const areas = adminAreasFor(useBrandId());
  const current = currentAdminArea(pathname, areas);
  return (
    <nav aria-label={t('label')}>
      <ul className={styles.bar}>
        {areas.map((a) => (
          <li key={a.id}>
            <Link href={a.href} aria-current={a.id === current?.id ? 'page' : undefined}>
              {t(`${a.id}.title`)}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
