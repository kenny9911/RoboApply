// /tools/[tool] — route shell (FND-6b). One free tool (job-alerts: WP-78).
//
// STUB. Owner: WP-57, who replaces this page. Public page in HybridShell (R-23): the app shell with a session,
// marketing chrome and the legal footer without one. Not indexed while a stub.
// Nothing links here until the owner ships and INT flips the entry.

import type { Metadata } from 'next';

import { HybridShell } from '../../../components/v3/shell/HybridShell';
import { LegalFooter } from '../../../components/features/market';

export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function ToolsToolPage({ params }: { params: Promise<{ tool: string }> }) {
  const { tool } = await params;
  return (
    <HybridShell from="tools" footer={<LegalFooter />}>
      <div hidden data-route-stub="/tools/[tool]" data-owner="WP-57" data-param={tool} />
    </HybridShell>
  );
}
