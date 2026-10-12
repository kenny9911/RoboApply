// /security — the security practices the code actually has (TASK_PLAN.md
// WP-40; F-TRUST-01). Per brand: AI routing and data location differ.

import type { Metadata } from 'next';

import { HybridShell } from '../../components/v3/shell/HybridShell';
import { JsonLd, MarketingFooter, SecurityPage } from '../../components/features/marketing';
import { supportEmailFor } from '../../components/features/marketing/brandEnv';
import { marketingRequest, subpageJsonLd, subpageMetadata } from '../../components/features/marketing/serverPage';

const NS = 'landing.security';

export async function generateMetadata(): Promise<Metadata> {
  return subpageMetadata(await marketingRequest(), NS, '/security');
}

export default async function SecurityRoute() {
  const req = await marketingRequest();
  return (
    <HybridShell from="security" footer={<MarketingFooter />}>
      <JsonLd json={subpageJsonLd(req, NS, '/security')} />
      <SecurityPage supportEmail={supportEmailFor(req.brand, process.env)} />
    </HybridShell>
  );
}
