// components/features/settings/sectionComponents.ts — section id → the owning
// area's settings component (FND-6a seam).
//
// A section whose content predates the clone (account, security,
// notifications, search, danger) is still rendered by
// app/(auth)/settings/page.tsx from the existing
// components/v3/{preferences,account} pieces. Every other section renders the
// component registered here, from `components/features/<area>/SettingsSection.tsx`
// (TASK_PLAN.md §4.1.e). FND-6b creates those stubs and the six new sections
// are wired below already (they stay hidden while `ready: false` in
// registry.ts, and the stubs render nothing), so their owners only fill
// `SettingsSection.tsx`. INT / WP-93 owns this file after Wave 1: when an
// owner takes over an existing section, its component goes here and the
// page's legacy renderer for it is deleted.
//
// Contract: `SettingsSectionProps` — the component receives the section id,
// because one area can own two sections (credits: billing + credits;
// compliance: privacy + consents; auth: account + security + danger).

import type { ComponentType } from 'react';

import { BrandSettingsSection } from '../brand';
import { ComplianceSettingsSection } from '../compliance';
import { CopilotSettingsSection } from '../copilot';
import { CreditsSettingsSection } from '../credits';
import { ExtensionSettingsSection } from '../extension';
import { GrowthSettingsSection } from '../growth';
import { NetworkSettingsSection } from '../network';
import { ProfileSettingsSection } from '../profile';
import type { SettingsSectionId } from './registry';

export interface SettingsSectionProps {
  section: SettingsSectionId;
}

export const SECTION_COMPONENTS: Partial<Record<SettingsSectionId, ComponentType<SettingsSectionProps>>> = {
  consents: ComplianceSettingsSection, // components/features/compliance/SettingsSection.tsx, WP-13
  privacy: ComplianceSettingsSection, // WP-13 (Wave 2 gate: replaces the page's DataSection wrapper)
  billing: CreditsSettingsSection, // components/features/credits/SettingsSection.tsx, WP-21b (Wave 2 gate: the page's legacy {tier} checkout got 409)
  credits: CreditsSettingsSection, // WP-21b (Wave 2 gate)
  appearance: BrandSettingsSection, // components/features/brand/SettingsSection.tsx, WP-12 (Wave 2 gate)
  assistant: CopilotSettingsSection, // components/features/copilot/SettingsSection.tsx, WP-51
  devices: ExtensionSettingsSection, // components/features/extension/SettingsSection.tsx, WP-55a
  connections: NetworkSettingsSection, // components/features/network/SettingsSection.tsx, WP-54
  referrals: GrowthSettingsSection, // components/features/growth/SettingsSection.tsx, WP-60
  sensitive: ProfileSettingsSection, // components/features/profile/SettingsSection.tsx, WP-19
};
