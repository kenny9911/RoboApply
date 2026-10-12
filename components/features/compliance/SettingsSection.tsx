'use client';

// /settings#privacy (both brands) and #consents (GoApply) — WP-13.
// Receives the section id (`SettingsSectionProps`), since compliance owns two
// sections. #privacy is also rendered through DataSection
// (components/v3/preferences/sections/PrivacySection.tsx) until INT moves the
// page's legacy renderer to this component.

import type { SettingsSectionProps } from '../settings/sectionComponents';
import { ConsentsPanel } from './ConsentsPanel';
import { PrivacyPanel } from './PrivacyPanel';

export function SettingsSection({ section }: SettingsSectionProps) {
  if (section === 'consents') return <ConsentsPanel />;
  if (section === 'privacy') return <PrivacyPanel />;
  return null;
}

export default SettingsSection;
