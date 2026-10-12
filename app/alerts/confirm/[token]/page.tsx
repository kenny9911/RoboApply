// /alerts/confirm/[token] — confirm a signed-out job alert (double opt-in; WP-78, F-NOTIF-03).
//
// Public page in HybridShell (R-23): the app shell with a session, marketing
// chrome and the legal footer without one. Opening the link changes nothing;
// the visitor presses Confirm (AlertConfirm). Never indexed; the token is
// never sent to third parties (no referrer leaves the page).

import type { Metadata } from 'next';

import { HybridShell } from '../../../../components/v3/shell/HybridShell';
import { LegalFooter } from '../../../../components/features/market';
import { AlertConfirm } from '../../../../components/features/visitor';

export const metadata: Metadata = { robots: { index: false, follow: false }, referrer: 'no-referrer' };

export default async function AlertsConfirmTokenPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  let decoded = token;
  try {
    decoded = decodeURIComponent(token);
  } catch {
    // keep the raw segment; the server rejects it
  }
  return (
    <HybridShell from="alerts" footer={<LegalFooter />}>
      <AlertConfirm token={decoded} />
    </HybridShell>
  );
}
