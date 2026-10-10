// /help/ranking — "How ranking works" (TASK_PLAN.md WP-40, WP-32, H14): every
// factor of the Recommended order with its weight, and what it never uses.
// Linked from the feed's sort menu (WP-33) and the marketing footer.

import type { Metadata } from 'next';

import { HybridShell } from '../../../components/v3/shell/HybridShell';
import { JsonLd, MarketingFooter, RankingPage } from '../../../components/features/marketing';
import { marketingRequest, subpageJsonLd, subpageMetadata } from '../../../components/features/marketing/serverPage';

const NS = 'landing.ranking';

export async function generateMetadata(): Promise<Metadata> {
  return subpageMetadata(await marketingRequest(), NS, '/help/ranking');
}

export default async function HelpRankingRoute() {
  const req = await marketingRequest();
  return (
    <HybridShell from="help" footer={<MarketingFooter />}>
      <JsonLd json={subpageJsonLd(req, NS, '/help/ranking')} />
      <RankingPage />
    </HybridShell>
  );
}
