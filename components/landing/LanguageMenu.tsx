'use client';

// Landing language menu. Unlike the in-app LanguageSwitcher (cookie +
// router.refresh on a flat URL), this renders REAL anchors to the localized
// landing URLs (`/`, `/es`, `/ja`, …) so crawlers discover the hreflang
// cluster from the SSR HTML — and clicking one both navigates and persists
// the choice to the robo_locale cookie for the rest of the session.

import { useLocale } from 'next-intl';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

import { setLocaleCookie } from '../../lib/locale';
import {
  LOCALE_LABELS,
  SEO_READY_LOCALES,
  localePath,
  type RoboLocale,
} from '../../lib/localeConfig';

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
        className="inline-flex h-9 items-center justify-center gap-1.5 rounded-pill border border-ink-line px-2 text-ink-700 transition-colors duration-150 hover:border-[color:var(--accent)] hover:text-accent-text sm:px-2.5"
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
          className="absolute right-0 top-10 z-50 min-w-[164px] overflow-hidden rounded-[var(--r-md)] border border-ink-line bg-bg-card py-1.5 shadow-lift"
        >
          {SEO_READY_LOCALES.map((locale) => (
            <Link
              key={locale}
              role="menuitem"
              href={localePath(locale)}
              hrefLang={locale}
              onClick={() => {
                setLocaleCookie(locale as RoboLocale);
                setOpen(false);
              }}
              className={`flex items-center justify-between gap-3 px-3.5 py-2 text-[13px] transition-colors duration-100 hover:bg-bg-page ${
                locale === active
                  ? 'font-semibold text-accent-text'
                  : 'text-ink-700'
              }`}
            >
              {LOCALE_LABELS[locale]}
              {locale === active && <span aria-hidden>✓</span>}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
