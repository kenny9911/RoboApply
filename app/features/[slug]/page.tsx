// /features/[slug] — route shell (FND-6b). Feature pages.
//
// STUB. Owner: WP-40, who replaces this page. Public page in HybridShell (R-23): the app shell with a session,
// marketing chrome and the legal footer without one. Not indexed while a stub.
// Nothing links here until the owner ships and INT flips the entry.

import type { Metadata } from 'next';

import { HybridShell } from '../../../components/v3/shell/HybridShell';
import { LegalFooter } from '../../../components/features/market';

export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function FeaturesSlugPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return (
    <HybridShell from="features" footer={<LegalFooter />}>
      <div hidden data-route-stub="/features/[slug]" data-owner="WP-40" data-param={slug} />
    </HybridShell>
  );
}
