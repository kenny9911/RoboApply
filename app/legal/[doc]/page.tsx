// /legal/[doc] — route shell (FND-6b). Legal documents per brand.
//
// STUB. Owner: WP-13, who replaces this page. Public page in HybridShell (R-23): the app shell with a session,
// marketing chrome and the legal footer without one. Not indexed while a stub.
// Nothing links here until the owner ships and INT flips the entry.

import type { Metadata } from 'next';

import { HybridShell } from '../../../components/v3/shell/HybridShell';
import { LegalFooter } from '../../../components/features/market';

export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function LegalDocPage({ params }: { params: Promise<{ doc: string }> }) {
  const { doc } = await params;
  return (
    <HybridShell from="legal" footer={<LegalFooter />}>
      <div hidden data-route-stub="/legal/[doc]" data-owner="WP-13" data-param={doc} />
    </HybridShell>
  );
}
