'use client';

// SettingsRail — the /settings section list rendered INSIDE the app Sidebar
// while the user is anywhere under /settings (FND-6a). One rail, not two:
// the destinations stay where they are and this group opens beneath them.
// Same source as the page (registry + useActiveSettingsSection), so the two
// cannot list different sections or disagree on which one is open.
//
// On /settings itself the sections are fragment anchors (#billing): same
// document, instant, and the browser fires hashchange. From a sub-route
// (/settings/billing/history) they are Next links to /settings#id.

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { cn } from '../../../lib/utils';
import { settingsHref } from './registry';
import { useActiveSettingsSection, useVisibleSettingsSections } from './useSettingsSection';

export function SettingsRail() {
  const t = useTranslations();
  const pathname = usePathname() ?? '';
  const sections = useVisibleSettingsSections();
  const active = useActiveSettingsSection(sections);
  const onSettingsPage = pathname === '/settings';
  const title = t('settings.title');

  return (
    <div className="nav-group" role="group" aria-label={title}>
      <div className="nav-section">{title}</div>
      {sections.map((s) => {
        const className = cn('nav-item nav-sub', s.danger && 'danger');
        const current = active === s.id ? ('page' as const) : undefined;
        const label = t(s.labelKey);
        return onSettingsPage ? (
          <a key={s.id} href={`#${s.id}`} className={className} aria-current={current}>
            {label}
          </a>
        ) : (
          <Link key={s.id} href={settingsHref(s.id)} scroll={false} className={className} aria-current={current}>
            {label}
          </Link>
        );
      })}
    </div>
  );
}
