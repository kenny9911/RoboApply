'use client';

// SettingsRailGroup — the Settings section list, rendered INSIDE the app
// Sidebar while the user is anywhere under /settings.
//
// There is one rail. /settings used to draw a second 260px rail of its own
// beside the 248px app rail, so the settings screen had two left columns
// saying two different things. Now the app rail is the only rail: the four
// destinations stay exactly where they are, and while you are inside Settings
// a group opens beneath them listing the seven sections. Leave /settings and
// the group is gone — Settings is still not a destination (ruling D2), and the
// phone bar still shows four tabs (D3); below 760px the page carries its own
// section row because the Sidebar is hidden there.
//
// Same source as the page: SETTINGS_SECTIONS + useSettingsSection, so the two
// rails cannot list different sections or disagree on which one is open.
//
// Links: on /settings itself the sections are fragment anchors (#billing) —
// same document, instant, and the browser fires hashchange. From a sub-route
// (/settings/billing/history) they are Next links to /settings#id, a real
// client navigation back to the page.

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  SETTINGS_SECTIONS,
  settingsSectionHref,
  useSettingsSection,
} from '../../../hooks/useSettingsSection';
import { cn } from '../../../lib/utils';

export function SettingsRailGroup() {
  const t = useTranslations('settings');
  const pathname = usePathname() ?? '';
  const section = useSettingsSection();
  const onSettingsPage = pathname === '/settings';

  return (
    <div className="nav-group" role="group" aria-label={t('title')}>
      <div className="nav-section">{t('title')}</div>
      {SETTINGS_SECTIONS.map((s) => {
        const active = section === s.id;
        const className = cn('nav-item nav-sub', s.danger && 'danger');
        const label = t(`nav.${s.id}`);
        const current = active ? ('page' as const) : undefined;
        return onSettingsPage ? (
          <a key={s.id} href={`#${s.id}`} className={className} aria-current={current}>
            {label}
          </a>
        ) : (
          <Link
            key={s.id}
            href={settingsSectionHref(s.id)}
            scroll={false}
            className={className}
            aria-current={current}
          >
            {label}
          </Link>
        );
      })}
    </div>
  );
}
