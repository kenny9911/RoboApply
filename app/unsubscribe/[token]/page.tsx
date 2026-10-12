// /unsubscribe/[token] — one-click unsubscribe from an email link (WP-39b; PRODUCT_PLAN.md F-NOTIF-04).
//
// Public page in HybridShell (R-23): the app shell with a session, marketing
// chrome and the legal footer without one. Works without signing in. Never
// indexed, and the token never leaves in a Referer header.

import type { Metadata } from 'next';

import { HybridShell } from '../../../components/v3/shell/HybridShell';
import { LegalFooter } from '../../../components/features/market';
import { UnsubscribeFlow } from '../../../components/features/notifications';

export const metadata: Metadata = { robots: { index: false, follow: false }, referrer: 'no-referrer' };

/** Tokens are base64url (nothing to decode); a stray escape is decoded once, safely. */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export default async function UnsubscribeTokenPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <HybridShell from="unsubscribe" footer={<LegalFooter />}>
      <UnsubscribeFlow token={safeDecode(token)} />
    </HybridShell>
  );
}
