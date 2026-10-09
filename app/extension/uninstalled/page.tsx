// /extension/uninstalled — route shell (FND-6b). Extension uninstall survey.
//
// STUB. Owner: WP-55a, who replaces this page. Public page in HybridShell (R-23): the app shell with a session,
// marketing chrome and the legal footer without one. Not indexed while a stub.
// Nothing links here until the owner ships and INT flips the entry.

import type { Metadata } from 'next';

import { HybridShell } from '../../../components/v3/shell/HybridShell';
import { LegalFooter } from '../../../components/features/market';

export const metadata: Metadata = { robots: { index: false, follow: false } };

export default function ExtensionUninstalledPage() {
  return (
    <HybridShell from="extension" footer={<LegalFooter />}>
      <div hidden data-route-stub="/extension/uninstalled" data-owner="WP-55a" />
    </HybridShell>
  );
}
