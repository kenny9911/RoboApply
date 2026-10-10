// components/features/settings/sectionComponents.ts — section id → the owning
// area's settings component, plus the area blocks mounted beside a section's
// content (FND-6a seam; wired by INT-12 / WP-93).
//
// SECTION_COMPONENTS: the component the frame renders for a section, from
// `components/features/<area>/SettingsSection.tsx` (TASK_PLAN.md §4.1.e).
//
//   notifications  NotificationsSettingsSection   WP-39b
//   billing        CreditsSettingsSection         WP-21b
//   credits        CreditsSettingsSection         WP-21b
//   privacy        ComplianceSettingsSection      WP-13
//   appearance     BrandSettingsSection           WP-12
//   consents       ComplianceSettingsSection      WP-13 (GoApply only)
//   search         SearchSettingsSection          WP-20 (saved searches)
//   assistant      CopilotSettingsSection         WP-51
//   devices        ExtensionSettingsSection       WP-55a
//   connections    NetworkSettingsSection         WP-54
//   referrals      GrowthSettingsSection          WP-60
//   sensitive      ProfileSettingsSection         WP-19
//
// Three sections keep a renderer in app/(auth)/settings/page.tsx, because
// their content is the pre-clone account pieces with controls no area
// component carries (retiring them would lose a control):
//   account   IdentitySection (preferences draft: pronouns, phone, links…)
//   security  SecurityCard (change password, sign out everywhere)
//   danger    DangerSection (delete job data, delete account)
// #search also gets the route's draft-backed notes, main resume and company
// blocklist under the saved searches (the frame's `extras` prop).
//
// SECTION_EXTRAS: blocks another area owns that sit inside a section, mounted
// by the frame itself so no route can forget them:
//   account   FinishSetupSettingsLine   onboarding (WP-30); nothing once setup is finished
//   security  TwoFactorSettings         account-v2 (WP-79); nothing while two-step sign-in cannot be turned on
//   security  ChangePhoneSection        auth-cn (WP-11); GoApply only
//
// Contract: `SettingsSectionProps` — the component receives the section id,
// because one area can own two sections (credits: billing + credits;
// compliance: privacy + consents).

import type { ComponentType } from 'react';

import type { BrandId } from '../../../lib/brand/registry.generated';
import { TwoFactorSettings } from '../account-v2';
import { ChangePhoneSection } from '../auth-cn';
import { BrandSettingsSection } from '../brand';
import { ComplianceSettingsSection } from '../compliance';
import { CopilotSettingsSection } from '../copilot';
import { CreditsSettingsSection } from '../credits';
import { ExtensionSettingsSection } from '../extension';
import { GrowthSettingsSection } from '../growth';
import { NetworkSettingsSection } from '../network';
import { NotificationsSettingsSection } from '../notifications';
import { FinishSetupSettingsLine } from '../onboarding';
import { ProfileSettingsSection } from '../profile';
import { SearchSettingsSection } from '../search';
import type { SettingsSectionId } from './registry';

export interface SettingsSectionProps {
  section: SettingsSectionId;
}

export const SECTION_COMPONENTS: Partial<Record<SettingsSectionId, ComponentType<SettingsSectionProps>>> = {
  notifications: NotificationsSettingsSection, // components/features/notifications/SettingsSection.tsx, WP-39b
  consents: ComplianceSettingsSection, // components/features/compliance/SettingsSection.tsx, WP-13
  privacy: ComplianceSettingsSection, // WP-13
  billing: CreditsSettingsSection, // components/features/credits/SettingsSection.tsx, WP-21b
  credits: CreditsSettingsSection, // WP-21b
  appearance: BrandSettingsSection, // components/features/brand/SettingsSection.tsx, WP-12
  search: SearchSettingsSection, // components/features/search/SettingsSection.tsx, WP-20
  assistant: CopilotSettingsSection, // components/features/copilot/SettingsSection.tsx, WP-51
  devices: ExtensionSettingsSection, // components/features/extension/SettingsSection.tsx, WP-55a
  connections: NetworkSettingsSection, // components/features/network/SettingsSection.tsx, WP-54
  referrals: GrowthSettingsSection, // components/features/growth/SettingsSection.tsx, WP-60
  sensitive: ProfileSettingsSection, // components/features/profile/SettingsSection.tsx, WP-19
};

/** A block another area owns, mounted inside a section by the frame. */
export interface SettingsSectionExtra {
  /** Stable id (React key, tests, `data-settings-extra`). */
  id: string;
  component: ComponentType;
  /** Above or below the section's own content. */
  position: 'before' | 'after';
  /** Brands that get it; absent = both. */
  brands?: readonly BrandId[];
  /** Owner WP, for the handoff trail. */
  wp: string;
}

export const SECTION_EXTRAS: Partial<Record<SettingsSectionId, readonly SettingsSectionExtra[]>> = {
  account: [{ id: 'finish-setup', component: FinishSetupSettingsLine, position: 'before', wp: 'WP-30' }],
  security: [
    { id: 'two-factor', component: TwoFactorSettings, position: 'after', wp: 'WP-79' },
    { id: 'change-phone', component: ChangePhoneSection, position: 'after', brands: ['goapply'], wp: 'WP-11' },
  ],
};

/** The extras of one section for a brand, in registry order. */
export function sectionExtrasFor(
  section: SettingsSectionId,
  brandId: BrandId,
  position: SettingsSectionExtra['position'],
  extras: Partial<Record<SettingsSectionId, readonly SettingsSectionExtra[]>> = SECTION_EXTRAS,
): SettingsSectionExtra[] {
  return (extras[section] ?? []).filter((e) => e.position === position && (!e.brands || e.brands.includes(brandId)));
}
