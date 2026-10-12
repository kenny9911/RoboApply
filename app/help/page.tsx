// /help — help FAQ, the support inbox and the contact form (TASK_PLAN.md
// WP-40; F-TRUST-07). The form posts to /support/contact (5/day/IP).

import type { Metadata } from 'next';

import { HybridShell } from '../../components/v3/shell/HybridShell';
import { HelpPage, JsonLd, MarketingFooter } from '../../components/features/marketing';
import { HELP_FAQ_KEYS } from '../../components/features/marketing/catalog';
import { supportEmailFor } from '../../components/features/marketing/brandEnv';
import { marketingRequest, subpageJsonLd, subpageMetadata } from '../../components/features/marketing/serverPage';

const NS = 'landing.help';

export async function generateMetadata(): Promise<Metadata> {
  return subpageMetadata(await marketingRequest(), NS, '/help');
}

export default async function HelpRoute() {
  const req = await marketingRequest();
  return (
    <HybridShell from="help" footer={<MarketingFooter />}>
      <JsonLd json={subpageJsonLd(req, NS, '/help', { base: NS, keys: HELP_FAQ_KEYS })} />
      <HelpPage supportEmail={supportEmailFor(req.brand, process.env)} />
    </HybridShell>
  );
}
