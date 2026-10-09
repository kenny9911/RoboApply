// /help/ranking — route shell (FND-6b). How ranking works.
//
// STUB. Owner: WP-40, who replaces this page. Public page in HybridShell (R-23): the app shell with a session,
// marketing chrome and the legal footer without one. Not indexed while a stub.
// Nothing links here until the owner ships and INT flips the entry.

import type { Metadata } from 'next';

import { HybridShell } from '../../../components/v3/shell/HybridShell';
import { LegalFooter } from '../../../components/features/market';

export const metadata: Metadata = { robots: { index: false, follow: false } };

export default function HelpRankingPage() {
  return (
    <HybridShell from="help" footer={<LegalFooter />}>
      <div hidden data-route-stub="/help/ranking" data-owner="WP-40" />
    </HybridShell>
  );
}
