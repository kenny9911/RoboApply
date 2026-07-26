'use client';

// ThemeToggle — the one-click appearance switch in the Topbar (and reused by
// MobileNav). Reads/writes lib/theme (persisted in localStorage; the provider
// writes data-theme on <html>, which flips the light/dark token scopes in
// app/globals.css). Two states only — light ⇄ dark; the third 'warm' mode was
// deleted with the accent picker (OVERHAUL_RULINGS.md R3). The icon shows the
// CURRENT mode (sun = light, moon = dark) and the label/title announce the
// mode you'd switch TO. Styled as a `.icon-btn` so it sits flush with the
// search / bell / language controls.

import { MoonIcon, SunIcon } from '@heroicons/react/24/outline';
import { useTranslations } from 'next-intl';
import { DEFAULT_THEME, useTheme } from '../../../lib/theme';

export function ThemeToggle({ className = 'icon-btn' }: { className?: string }) {
  const t = useTranslations('nav_v3');
  const { theme, toggle, hydrated } = useTheme();
  // Until mounted, render the server's DEFAULT theme so the icon/label match the
  // SSR'd HTML (the provider already holds the persisted theme on first client
  // render — see lib/theme `hydrated`). Post-mount, swap to the real theme.
  const current = hydrated ? theme : DEFAULT_THEME.theme;
  const label = t(current === 'dark' ? 'theme_to_light' : 'theme_to_dark');
  const iconStyle = { width: 15, height: 15 } as const;

  return (
    <button
      type="button"
      className={className}
      onClick={toggle}
      aria-label={label}
      title={label}
    >
      {current === 'dark' ? (
        <MoonIcon style={iconStyle} aria-hidden="true" />
      ) : (
        <SunIcon style={iconStyle} aria-hidden="true" />
      )}
    </button>
  );
}
