'use client';

// Settings § Appearance — light or dark. That is the whole surface.
//
// The accent picker, the density picker and the `warm` theme were deleted in
// OVERHAUL_RULINGS R3, so this section holds exactly one bit. It writes through
// lib/theme's provider (localStorage + <html data-theme>), NOT through the
// preferences blob — appearance is a device choice, not an account setting, and
// the no-flash bootstrap in app/layout.tsx reads the same localStorage key.
//
// `hydrated` gates the rendered selection: the provider seeds from localStorage
// in its useState initializer, so the first client render can legitimately
// differ from the server's DEFAULT_THEME. Render the default until mounted or
// React reports a hydration mismatch.

import { useTranslations } from 'next-intl';
import { PrefHeader, PrefGroup, PrefRow, Segmented } from '../controls';
import { DEFAULT_THEME, useTheme, type ThemeKey } from '../../../../lib/theme';

export function AppearanceSection() {
  const t = useTranslations('settings');
  const { theme, setTheme, hydrated } = useTheme();
  const shown: ThemeKey = hydrated ? theme : DEFAULT_THEME.theme;

  return (
    <>
      <PrefHeader
        eyebrow={t('nav.appearance')}
        title={t('appearance.title')}
        sub={t('appearance.sub')}
      />

      <PrefGroup label={t('appearance.group')}>
        <PrefRow label={t('appearance.theme_label')} sub={t('appearance.theme_sub')}>
          <Segmented
            value={shown}
            onChange={(v) => setTheme(v as ThemeKey)}
            options={[
              { value: 'light', label: t('appearance.light') },
              { value: 'dark', label: t('appearance.dark') },
            ]}
          />
        </PrefRow>
      </PrefGroup>
    </>
  );
}
