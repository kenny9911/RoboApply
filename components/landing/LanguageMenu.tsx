'use client';

// Landing language menu. Unlike the in-app LanguageSwitcher (cookie +
// router.refresh on a flat URL), this renders REAL anchors to the localized
// landing URLs (`/`, `/es`, `/ja`, …) so crawlers discover the hreflang
// cluster from the SSR HTML — and clicking one both navigates and persists
// the choice to the robo_locale cookie for the rest of the session.
//
// The items are plain <a> elements, not next/link, on purpose: the locale and
// its message bundle are resolved by the ROOT layout (app/layout.tsx:
// <html lang>, NextIntlClientProvider), and a client-side navigation keeps
// that layout mounted. A soft navigation to /zh-TW changed the URL and the
// tab title and left every word on the page in the old language until a
// reload. A language change is a full document load.
//
// The list is the request brand's locales (TASK_PLAN.md WP-12, ARCHITECTURE.md
// §1.6): the same list as the in-app LanguageSwitcher, limited to locales
// whose landing is translated (SEO_READY_LOCALES), with paths relative to the
// brand's default locale (`/` is English on RoboApply, 简体中文 on GoApply).

import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useMemo, useRef, useState } from 'react';

import { useBrand } from '../../lib/brand';
import { setLocaleCookie } from '../../lib/locale';
import { SEO_READY_LOCALES, isLocaleIn, localePath } from '../../lib/localeConfig';
import { brandSwitcherLocales } from '../features/brand/locales';

function GlobeIcon() {
  return (
    <svg
      width={15}
      height={15}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18Z" />
    </svg>
  );
}

export interface LanguageMenuProps {
  /** Accessible name of the button. Default: "Change language" in the page's language. */
  label?: string;
}

export function LanguageMenu({ label }: LanguageMenuProps = {}) {
  const t = useTranslations('landing.header');
  const name = label ?? t('lang_label');
  const active = useLocale();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const brand = useBrand();
  const items = useMemo(
    () => brandSwitcherLocales(brand.locales).filter((l) => isLocaleIn(l.code, SEO_READY_LOCALES)),
    [brand.locales],
  );

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent | TouchEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('touchstart', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('touchstart', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // A language link leaves the page with the menu open; a page restored from
  // the back-forward cache must not come back with it open.
  useEffect(() => {
    const close = () => setOpen(false);
    window.addEventListener('pagehide', close);
    return () => window.removeEventListener('pagehide', close);
  }, []);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={name}
        title={name}
        className="inline-flex h-11 min-w-[44px] items-center justify-center gap-1.5 rounded-pill border border-ink-line px-2 text-ink-700 transition-colors duration-150 hover:border-[color:var(--action)] hover:text-accent-text sm:px-2.5"
      >
        <GlobeIcon />
        {/* Current-language code — makes the 9-language story visible above
            the fold instead of hiding behind an unlabeled globe. */}
        <span className="hidden font-mono text-[11px] font-medium uppercase tracking-[0.08em] sm:inline">
          {active}
        </span>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-12 z-50 min-w-[164px] overflow-hidden rounded-[var(--r-md)] border border-ink-line bg-bg-card py-1.5 shadow-lift"
        >
          {items.map(({ code, label: language }) => (
            <a
              key={code}
              role="menuitem"
              href={localePath(code, brand.defaultLocale)}
              hrefLang={code}
              lang={code}
              aria-current={code === active ? 'true' : undefined}
              // Only the cookie: the browser follows the link itself. The
              // menu is not closed here — that would take this anchor out of
              // the document in the middle of its own click; it goes with the
              // page (and `pagehide` closes it for a back-forward restore).
              onClick={() => setLocaleCookie(code)}
              className={`flex min-h-[44px] items-center justify-between gap-3 px-3.5 py-2 text-[13px] transition-colors duration-100 hover:bg-bg-page ${
                code === active
                  ? 'font-semibold text-accent-text'
                  : 'text-ink-700'
              }`}
            >
              {language}
              {code === active && <span aria-hidden>✓</span>}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
