'use client';

// SettingsPage — the /settings frame (FND-6a; PRODUCT_PLAN.md §3.4, F-ACCT-05).
//
// It owns WHICH sections exist, in what order, and which one is open (the
// registry + the URL hash). It does not own their content:
//   • `renderers` — the route passes content for the sections it renders
//     itself (the pre-clone account, security and danger pieces in
//     app/(auth)/settings/page.tsx);
//   • otherwise the area component registered in `sectionComponents.ts`;
//   • otherwise nothing (a section is only `ready` once it has content).
// Around that content, in this order:
//   registered "before" extras · route `extras.before` · content ·
//   route `extras.after` · registered "after" extras
// The registered extras (`SECTION_EXTRAS`: finish-setup line, two-step
// sign-in, GoApply phone number) are mounted here, per brand, so they show
// whatever the route passes.
//
// No empty panel: an area component may render nothing while its data loads
// or when its request failed. A blank section under a lit nav item is a dead
// end, so when the open section's body is still empty after
// EMPTY_SECTION_DELAY_MS the frame says the section did not load and what to
// do (`<SectionBody>`). It disappears the moment the section renders anything.
//
// Below 760px the Sidebar is hidden, so the page carries its own section row
// (a sticky horizontal scroller, styles/v3-preferences.css `.pref-rail`):
// every section — plan changes, cancellation, account deletion — stays
// reachable on a phone. Fragment anchors, because the section IS the hash.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';

import { useBrandId } from '../../../lib/brand/BrandProvider';
import { cn } from '../../../lib/utils';
import type { SettingsSectionId } from './registry';
import { SECTION_COMPONENTS, sectionExtrasFor } from './sectionComponents';
import { useActiveSettingsSection, useVisibleSettingsSections } from './useSettingsSection';

export type SettingsRenderers = Partial<Record<SettingsSectionId, () => ReactNode>>;

/** Route content placed above / below a section's own content. */
export type SettingsRouteExtras = Partial<Record<SettingsSectionId, { before?: () => ReactNode; after?: () => ReactNode }>>;

export interface SettingsPageProps {
  renderers?: SettingsRenderers;
  /** Route content around a section (e.g. the draft-backed notes under the saved searches). */
  extras?: SettingsRouteExtras;
  /** Shown instead of the body while the route's data loads. */
  loading?: boolean;
  /** Below the body (e.g. the unsaved-changes bar). */
  footer?: ReactNode;
  /** Called when the open section changes (the route resets scroll, etc.). */
  onSectionChange?: (id: SettingsSectionId | null) => void;
}

/** How long an open section may stay blank before the frame says so (a loading flash is not an empty panel). */
export const EMPTY_SECTION_DELAY_MS = 1500;

/**
 * The open section's content plus the no-empty-panel fallback. `display:
 * contents` keeps the children laid out exactly as direct children of
 * `.pref-body` would be.
 */
function SectionBody({ section, children }: { section: SettingsSectionId; children: ReactNode }) {
  // Full keys, like the frame below (labels come from two namespaces).
  const t = useTranslations();
  const ref = useRef<HTMLDivElement>(null);
  const [blank, setBlank] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const isBlank = () => el.childElementCount === 0 && !(el.textContent ?? '').trim();
    const check = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      if (!isBlank()) {
        setBlank(false);
        return;
      }
      timer = setTimeout(() => setBlank(isBlank()), EMPTY_SECTION_DELAY_MS);
    };
    setBlank(false);
    check();
    const observer = typeof MutationObserver === 'undefined' ? null : new MutationObserver(check);
    observer?.observe(el, { childList: true, subtree: true, characterData: true });
    return () => {
      observer?.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, [section]);

  return (
    <>
      <div ref={ref} style={{ display: 'contents' }} data-settings-body={section}>
        {children}
      </div>
      {blank ? (
        <p className="pref-sub" role="status" data-testid="settings-section-empty">
          {t('nav.settingsEmpty')}
        </p>
      ) : null}
    </>
  );
}

export function SettingsPage({ renderers = {}, extras = {}, loading = false, footer, onSectionChange }: SettingsPageProps) {
  const t = useTranslations();
  const brandId = useBrandId();
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
  const content = active ? (renderers[active]?.() ?? (Component ? <Component section={active} /> : null)) : null;
  const mounted = (position: 'before' | 'after') =>
    active
      ? sectionExtrasFor(active, brandId, position).map((extra) => {
          const Extra = extra.component;
          return <Extra key={extra.id} />;
        })
      : null;
  const body = active ? (
    <SectionBody section={active}>
      {mounted('before')}
      {extras[active]?.before?.()}
      {content}
      {extras[active]?.after?.()}
      {mounted('after')}
    </SectionBody>
  ) : null;

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
