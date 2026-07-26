'use client';

// Landing theme toggle — flips between the two appearances the product has:
// light (the default) and dark. The third 'warm' scope is gone with the accent
// picker (OVERHAUL_RULINGS.md R3); the landing-scoped token overrides in
// styles/landing.css still render 'light' with the warm palette there, so the
// landing keeps its own look without a theme of its own.
//
// Writes through useTheme() so the choice persists to localStorage and follows
// the user into the app.

import { useTranslations } from 'next-intl';

import { DEFAULT_THEME, useTheme } from '../../lib/theme';

function SunIcon() {
  return (
    <svg
      width={15}
      height={15}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="4.4" />
      <path d="M12 2.5v2.4M12 19.1v2.4M2.5 12h2.4M19.1 12h2.4M5 5l1.7 1.7M17.3 17.3 19 19M19 5l-1.7 1.7M6.7 17.3 5 19" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg
      width={15}
      height={15}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20.2 14.2A8.3 8.3 0 0 1 9.8 3.8a8.3 8.3 0 1 0 10.4 10.4Z" />
    </svg>
  );
}

export function ThemeToggle() {
  const t = useTranslations('landing.header');
  const { theme, toggle, hydrated } = useTheme();
  // Until mounted, use the server's DEFAULT theme so the icon/label match the
  // SSR'd HTML; the provider already holds the persisted theme while hydrating.
  const isDark = (hydrated ? theme : DEFAULT_THEME.theme) === 'dark';

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={isDark ? t('theme_to_light') : t('theme_to_dark')}
      title={isDark ? t('theme_to_light') : t('theme_to_dark')}
      className="inline-flex h-9 w-9 items-center justify-center rounded-[var(--r-pill)] border border-[color:var(--rule)] text-[color:var(--text-2)] transition-colors duration-[var(--dur-hover)] hover:border-[color:var(--rule-strong)] hover:text-[color:var(--text)]"
    >
      {isDark ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}
