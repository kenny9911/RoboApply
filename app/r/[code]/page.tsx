// /r/[code] — where an invite link lands (PRODUCT_PLAN.md F-GROW-01;
// TASK_PLAN.md WP-60). Public page in HybridShell (R-23): the app shell with
// a session, marketing chrome and the legal footer without one. Not indexed
// (every code is personal). The code goes on to signup as `?ref=<code>`; the
// server attaches it to the new account (growth.recordAttribution).

import type { Metadata } from 'next';

import { HybridShell } from '../../../components/v3/shell/HybridShell';
import { LegalFooter } from '../../../components/features/market';
import { InviteLanding } from '../../../components/features/growth';

export const metadata: Metadata = { robots: { index: false, follow: false }, referrer: 'no-referrer' };

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return '';
  }
}

export default async function InviteLinkPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  return (
    <HybridShell from="invite" footer={<LegalFooter />}>
      <InviteLanding code={safeDecode(code).slice(0, 32)} />
    </HybridShell>
  );
}
