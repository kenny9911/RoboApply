'use client';

// components/v3/admin/AdminNav.tsx — navigation to every admin area (WP-74).
//
// `ADMIN_AREAS` is the one list of admin sub-routes, built by their owning
// WPs: System and Reports to review (WP-74), Credits (WP-21b), Announcements
// (WP-61, the "What's new" admin entry), Practice questions (WP-59), Coaches
// (WP-72), Company job boards (WP-42), and GoApply's campus calendar (WP-58),
// suspicious jobs (WP-41) and invite codes (WP-11). An area that belongs to
// one brand shows only on that brand's host. Admins see every area of their
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
  { id: 'credits', href: '/admin/credits', owner: 'WP-21b' },
  { id: 'announcements', href: '/admin/announcements', owner: 'WP-61' },
  { id: 'questions', href: '/admin/questions', owner: 'WP-59' },
  { id: 'coaches', href: '/admin/coaches', owner: 'WP-72' },
  { id: 'sources', href: '/admin/sources', brands: ['roboapply'], owner: 'WP-42' },
  { id: 'campus', href: '/admin/campus', brands: ['goapply'], owner: 'WP-58' },
  { id: 'fraud', href: '/admin/fraud', brands: ['goapply'], owner: 'WP-41' },
  { id: 'invites', href: '/admin/invites', brands: ['goapply'], owner: 'WP-11' },
];

export function adminAreasFor(brand: BrandId): AdminArea[] {
  return ADMIN_AREAS.filter((a) => !a.brands || a.brands.includes(brand));
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
  return (
    <nav aria-label={t('label')}>
      <ul className={styles.bar}>
        {areas.map((a) => {
          const current = a.href === '/admin' ? pathname === '/admin' : pathname === a.href || pathname.startsWith(`${a.href}/`);
          return (
            <li key={a.id}>
              <Link href={a.href} aria-current={current ? 'page' : undefined}>
                {t(`${a.id}.title`)}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
