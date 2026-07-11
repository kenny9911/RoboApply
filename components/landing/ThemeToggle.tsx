'use client';

// Landing theme toggle — flips between the two landing appearances:
// dark ("night shift", the electric V3 palette) and warm (the Anthropic
// clay-on-cream scope, which the landing treats as its light mode; the
// landing-scoped token overrides in styles/landing.css render the app's
// 'light' theme with the same warm palette there).
//
// Writes through useDcTheme() so the choice persists to localStorage and
// follows the user into the app.

import { useTranslations } from 'next-intl';

import { DEFAULT_THEME, useDcTheme } from '../../lib/dcTheme';

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
  const { theme, set, hydrated } = useDcTheme();
  // Until mounted, use the server's DEFAULT theme so the icon/label match the
  // SSR'd HTML; the provider already holds the persisted theme while hydrating.
  const isDark = (hydrated ? theme : DEFAULT_THEME.theme) === 'dark';

  return (
    <button
      type="button"
      // Toggle relative to the REAL current theme, never the pre-mount placeholder.
      onClick={() => set('theme', theme === 'dark' ? 'warm' : 'dark')}
      aria-label={isDark ? t('theme_to_light') : t('theme_to_dark')}
      title={isDark ? t('theme_to_light') : t('theme_to_dark')}
      className="inline-flex h-9 w-9 items-center justify-center rounded-pill border border-ink-line text-ink-700 transition-colors duration-150 hover:border-[color:var(--accent)] hover:text-accent-text"
    >
      {isDark ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}
