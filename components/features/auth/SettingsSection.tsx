'use client';

// /settings#account, #security and #danger (WP-10). The settings page still
// renders its legacy content for these sections (IdentitySection,
// SecurityCard, DangerSection — which now embed the WP-10 pieces below);
// this component is what the frame renders when no legacy renderer is
// passed (components/features/settings/sectionComponents.ts, INT).

import type { SettingsSectionProps } from '../settings/sectionComponents';
import { EmailVerificationLine, SignedInSessions, SignInMethods } from './SecuritySettings';

export function SettingsSection({ section }: SettingsSectionProps) {
  if (section === 'account') return <EmailVerificationLine />;
  if (section === 'security') {
    return (
      <>
        <SignInMethods />
        <SignedInSessions />
      </>
    );
  }
  return null;
}

export default SettingsSection;
