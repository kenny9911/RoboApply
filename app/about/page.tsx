// /about — what the brand is, what it will not do, who runs it (TASK_PLAN.md
// WP-40; F-MKT-04). The operating entity shows only when configured
// (LEGAL_ENTITY_NAME / CN_LEGAL_ENTITY_NAME); never invented (D3).

import type { Metadata } from 'next';

import { HybridShell } from '../../components/v3/shell/HybridShell';
import { AboutPage, JsonLd, MarketingFooter } from '../../components/features/marketing';
import { legalEntityFor, supportEmailFor } from '../../components/features/marketing/brandEnv';
import { marketingRequest, subpageJsonLd, subpageMetadata } from '../../components/features/marketing/serverPage';

const NS = 'landing.about';

export async function generateMetadata(): Promise<Metadata> {
  return subpageMetadata(await marketingRequest(), NS, '/about');
}

export default async function AboutRoute() {
  const req = await marketingRequest();
  return (
    <HybridShell from="about" footer={<MarketingFooter />}>
      <JsonLd json={subpageJsonLd(req, NS, '/about')} />
      <AboutPage entity={legalEntityFor(req.brand, process.env)} supportEmail={supportEmailFor(req.brand, process.env)} />
    </HybridShell>
  );
}
