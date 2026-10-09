// /browse/[...path] — route shell (FND-6b). Programmatic job lists from live inventory.
//
// STUB. Owner: WP-56, who replaces this page. Public page in HybridShell (R-23): the app shell with a session,
// marketing chrome and the legal footer without one. Not indexed while a stub.
// Nothing links here until the owner ships and INT flips the entry.

import type { Metadata } from 'next';

import { HybridShell } from '../../../components/v3/shell/HybridShell';
import { LegalFooter } from '../../../components/features/market';
import { VisitorFeed } from '../../../components/features/visitor';

export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function BrowsePathPage({ params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  return (
    <HybridShell from="browse" footer={<LegalFooter />}>
      <>
        <div hidden data-route-stub="/browse/[...path]" data-owner="WP-56" data-param={path.join('/')} />
        <VisitorFeed from="browse" />
      </>
    </HybridShell>
  );
}
