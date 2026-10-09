// /r/[code] — route shell (FND-6b). Invite link landing (attribution, then signup).
//
// STUB. Owner: WP-60, who replaces this page. Public page in HybridShell (R-23): the app shell with a session,
// marketing chrome and the legal footer without one. Not indexed while a stub.
// Nothing links here until the owner ships and INT flips the entry.

import type { Metadata } from 'next';

import { HybridShell } from '../../../components/v3/shell/HybridShell';
import { LegalFooter } from '../../../components/features/market';

export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function RCodePage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  return (
    <HybridShell from="invite" footer={<LegalFooter />}>
      <div hidden data-route-stub="/r/[code]" data-owner="WP-60" data-param={code} />
    </HybridShell>
  );
}
