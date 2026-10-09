// /alerts/confirm/[token] — route shell (FND-6b). Confirm a signed-out job alert (double opt-in).
//
// STUB. Owner: WP-78, who replaces this page. Public page in HybridShell (R-23): the app shell with a session,
// marketing chrome and the legal footer without one. Not indexed while a stub.
// Nothing links here until the owner ships and INT flips the entry.

import type { Metadata } from 'next';

import { HybridShell } from '../../../../components/v3/shell/HybridShell';
import { LegalFooter } from '../../../../components/features/market';

export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function AlertsConfirmTokenPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <HybridShell from="alerts" footer={<LegalFooter />}>
      <div hidden data-route-stub="/alerts/confirm/[token]" data-owner="WP-78" data-param={token} />
    </HybridShell>
  );
}
