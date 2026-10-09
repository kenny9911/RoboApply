'use client';

// Settings § Appearance — the page's legacy renderer for #appearance
// (app/(auth)/settings/page.tsx). The section now lives with the brand
// presentation area (components/features/brand/SettingsSection.tsx, WP-12);
// this wrapper keeps the existing import working.
//
// @deprecated Render `BrandSettingsSection` from components/features/brand
// (registered in components/features/settings/sectionComponents.ts by INT).

import { SettingsSection } from '../../../features/brand/SettingsSection';

export function AppearanceSection() {
  return <SettingsSection section="appearance" />;
}
