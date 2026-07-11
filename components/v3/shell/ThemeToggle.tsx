'use client';

// ThemeToggle — the one-click appearance cycle in the Topbar (and reused by
// MobileNav). Reads/writes the dcTheme `theme` (persisted in localStorage; the
// provider writes data-theme on <html>, which flips the bare-token light/warm
// scopes in app/globals.css). Cycles dark → light → warm → dark. The icon shows
// the CURRENT mode (moon = dark, sun = light, flame = warm/Anthropic) and the
// label/title announce the NEXT mode you'd switch to. Styled as a `.icon-btn`
// so it sits flush with the search / bell / language controls.

import { FireIcon, MoonIcon, SunIcon } from '@heroicons/react/24/outline';
import { useTranslations } from 'next-intl';
import { DEFAULT_THEME, type ThemeKey, useDcTheme } from '../../../lib/dcTheme';

const NEXT: Record<ThemeKey, ThemeKey> = {
  dark: 'light',
  light: 'warm',
  warm: 'dark',
};

const NEXT_LABEL_KEY: Record<ThemeKey, string> = {
  light: 'theme_to_warm',
  warm: 'theme_to_dark',
  dark: 'theme_to_light',
};

export function ThemeToggle({ className = 'icon-btn' }: { className?: string }) {
  const t = useTranslations('nav_v3');
  const theme = useDcTheme();
  // Until mounted, render the server's DEFAULT theme so the icon/label match the
  // SSR'd HTML (the provider already holds the persisted theme on first client
  // render — see dcTheme `hydrated`). Post-mount, swap to the real theme.
  const current = theme.hydrated ? theme.theme : DEFAULT_THEME.theme;
  const label = t(NEXT_LABEL_KEY[current]);
  const iconStyle = { width: 15, height: 15 } as const;

  return (
    <button
      type="button"
      className={className}
      // Toggle relative to the REAL current theme, never the pre-mount placeholder.
      onClick={() => theme.set('theme', NEXT[theme.theme])}
      aria-label={label}
      title={label}
    >
      {current === 'dark' ? (
        <MoonIcon style={iconStyle} aria-hidden="true" />
      ) : current === 'light' ? (
        <SunIcon style={iconStyle} aria-hidden="true" />
      ) : (
        <FireIcon style={iconStyle} aria-hidden="true" />
      )}
    </button>
  );
}
