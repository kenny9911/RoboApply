// /job/[idSlug] — route shell (FND-6b). Public job page, `<cuid>-<slug>` (R-05).
//
// STUB. Owner: WP-56, who replaces this page. Public page in HybridShell (R-23): the app shell with a session,
// marketing chrome and the legal footer without one. Not indexed while a stub.
// Nothing links here until the owner ships and INT flips the entry.

import type { Metadata } from 'next';

import { HybridShell } from '../../../components/v3/shell/HybridShell';
import { LegalFooter } from '../../../components/features/market';

export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function JobIdSlugPage({ params }: { params: Promise<{ idSlug: string }> }) {
  const { idSlug } = await params;
  return (
    <HybridShell from="job" footer={<LegalFooter />}>
      <div hidden data-route-stub="/job/[idSlug]" data-owner="WP-56" data-param={idSlug} />
    </HybridShell>
  );
}
