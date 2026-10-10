// /cancel — cancel a subscription without signing in (PRODUCT_PLAN.md §3.4,
// F-BILL-03; §312k BGB). Public page in HybridShell (R-23): the app shell with
// a session, marketing chrome and the legal footer without one. Every footer
// links here (`CancelFooterLink`; German label "Verträge hier kündigen").
//
// RoboApply flow: email → one-time link (30 min, single use) →
// `/cancel?token=…` → "Cancel now". The token is passed to the client once and
// stripped from the address bar there. Token pages are never indexed.
//
// GoApply (mainland market) sells passes that are paid once and never renew:
// there is no subscription to cancel and no cancel link to email. The page
// says so (`NoRenewalNotice`) instead of asking for an email address.

import type { Metadata } from 'next';

import { HybridShell } from '../../components/v3/shell/HybridShell';
import { NoRenewalNotice, brandHasRenewingPlans } from '../../components/features/billing-cn';
import { LegalFooter } from '../../components/features/market';
import { PublicCancelFlow } from '../../components/features/credits';
import { getServerBrand } from '../../lib/server/brand';

export const metadata: Metadata = { robots: { index: false, follow: true } };

export default async function CancelPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const brand = await getServerBrand();
  if (!brandHasRenewingPlans(brand)) {
    return (
      <HybridShell from="cancel" footer={<LegalFooter />}>
        <NoRenewalNotice />
      </HybridShell>
    );
  }
  const params = await searchParams;
  const token = typeof params.token === 'string' && params.token.length <= 512 ? params.token : null;
  return (
    <HybridShell from="cancel" footer={<LegalFooter />}>
      <PublicCancelFlow token={token} />
    </HybridShell>
  );
}
