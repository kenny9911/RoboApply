// /campus — route shell (FND-6b). GoApply 校招日历 (flag `jobs.campusCalendar`).
//
// STUB. Owner: WP-58, who replaces this page. Public page in HybridShell (R-23): the app shell with a session,
// marketing chrome and the legal footer without one. Not indexed while a stub.
// Nothing links here until the owner ships and INT flips the entry.

import type { Metadata } from 'next';

import { HybridShell } from '../../components/v3/shell/HybridShell';
import { LegalFooter } from '../../components/features/market';

export const metadata: Metadata = { robots: { index: false, follow: false } };

export default function CampusPage() {
  return (
    <HybridShell from="campus" footer={<LegalFooter />}>
      <div hidden data-route-stub="/campus" data-owner="WP-58" />
    </HybridShell>
  );
}
