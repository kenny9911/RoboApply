// /pricing — public pricing for both brands (TASK_PLAN.md WP-40; F-BILL-02;
// PRODUCT §6). In HybridShell (R-23): the app shell with a session, marketing
// chrome without one. Prices come from GET /billing/plans and caps from the
// credit catalog; GoApply shows the fee schedule as "Not open yet" until CN
// payments open (R-15).

import type { Metadata } from 'next';

import { HybridShell } from '../../components/v3/shell/HybridShell';
import { JsonLd, MarketingFooter, PricingPage } from '../../components/features/marketing';
import { PRICING_FAQ_KEYS } from '../../components/features/marketing/catalog';
import { marketingRequest, subpageJsonLd, subpageMetadata } from '../../components/features/marketing/serverPage';

const NS = 'landing.pricingPage';

export async function generateMetadata(): Promise<Metadata> {
  return subpageMetadata(await marketingRequest(), NS, '/pricing');
}

export default async function PricingRoute() {
  const req = await marketingRequest();
  return (
    <HybridShell from="pricing" footer={<MarketingFooter />}>
      <JsonLd json={subpageJsonLd(req, NS, '/pricing', { base: NS, keys: PRICING_FAQ_KEYS })} />
      <PricingPage />
    </HybridShell>
  );
}
