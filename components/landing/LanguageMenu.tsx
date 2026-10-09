'use client';

// Landing language menu. Unlike the in-app LanguageSwitcher (cookie +
// router.refresh on a flat URL), this renders REAL anchors to the localized
// landing URLs (`/`, `/es`, `/ja`, …) so crawlers discover the hreflang
// cluster from the SSR HTML — and clicking one both navigates and persists
// the choice to the robo_locale cookie for the rest of the session.
//
// The list is the request brand's locales (TASK_PLAN.md WP-12, ARCHITECTURE.md
// §1.6): the same list as the in-app LanguageSwitcher, limited to locales
// whose landing is translated (SEO_READY_LOCALES), with paths relative to the
// brand's default locale (`/` is English on RoboApply, 简体中文 on GoApply).

import { useLocale } from 'next-intl';
import Link from 'next/link';
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

export function LanguageMenu({ label }: { label: string }) {
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

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={label}
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
          {items.map(({ code, label: name }) => (
            <Link
              key={code}
              role="menuitem"
              href={localePath(code, brand.defaultLocale)}
              hrefLang={code}
              onClick={() => {
                setLocaleCookie(code);
                setOpen(false);
              }}
              className={`flex min-h-[44px] items-center justify-between gap-3 px-3.5 py-2 text-[13px] transition-colors duration-100 hover:bg-bg-page ${
                code === active
                  ? 'font-semibold text-accent-text'
                  : 'text-ink-700'
              }`}
            >
              {name}
              {code === active && <span aria-hidden>✓</span>}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
