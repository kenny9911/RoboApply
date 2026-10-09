'use client';

// SettingsPage — the /settings frame (FND-6a; PRODUCT_PLAN.md §3.4, F-ACCT-05).
//
// It owns WHICH sections exist, in what order, and which one is open (the
// registry + the URL hash). It does not own their content:
//   • `renderers` — the route passes content for the sections it renders
//     itself (the pre-clone settings pieces in app/(auth)/settings/page.tsx);
//   • otherwise the area component registered in `sectionComponents.ts`;
//   • otherwise nothing (a section is only `ready` once it has content).
//
// Below 760px the Sidebar is hidden, so the page carries its own section row
// (a sticky horizontal scroller, styles/v3-preferences.css `.pref-rail`):
// every section — plan changes, cancellation, account deletion — stays
// reachable on a phone. Fragment anchors, because the section IS the hash.

import { useEffect, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';

import { cn } from '../../../lib/utils';
import type { SettingsSectionId } from './registry';
import { SECTION_COMPONENTS } from './sectionComponents';
import { useActiveSettingsSection, useVisibleSettingsSections } from './useSettingsSection';

export type SettingsRenderers = Partial<Record<SettingsSectionId, () => ReactNode>>;

export interface SettingsPageProps {
  renderers?: SettingsRenderers;
  /** Shown instead of the body while the route's data loads. */
  loading?: boolean;
  /** Below the body (e.g. the unsaved-changes bar). */
  footer?: ReactNode;
  /** Called when the open section changes (the route resets scroll, etc.). */
  onSectionChange?: (id: SettingsSectionId | null) => void;
}

export function SettingsPage({ renderers = {}, loading = false, footer, onSectionChange }: SettingsPageProps) {
  const t = useTranslations();
  const sections = useVisibleSettingsSections();
  const active = useActiveSettingsSection(sections);

  useEffect(() => {
    onSectionChange?.(active);
  }, [active, onSectionChange]);

  if (loading) {
    return (
      <div className="pref">
        <div className="pref-body">
          <p className="pref-sub">{t('settings.loading')}</p>
        </div>
      </div>
    );
  }

  const Component = active ? SECTION_COMPONENTS[active] : undefined;
  const body = active ? (renderers[active]?.() ?? (Component ? <Component section={active} /> : null)) : null;

  return (
    <div className="pref" data-settings-section={active ?? ''}>
      <aside className="pref-rail">
        <div className="pref-rail-head">
          <div className="pref-rail-title">{t('settings.title')}</div>
        </div>
        <nav className="pref-nav" aria-label={t('settings.title')}>
          {sections.map((s) => (
            <a
              key={s.id}
              href={`#${s.id}`}
              className={cn('pref-nav-item', active === s.id && 'active', s.danger && 'danger')}
              aria-current={active === s.id ? 'page' : undefined}
            >
              {t(s.labelKey)}
            </a>
          ))}
        </nav>
      </aside>

      <div className="pref-body" id={active ? `settings-${active}` : undefined}>
        {body}
      </div>

      {footer}
    </div>
  );
}
