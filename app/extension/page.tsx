// /extension — the browser extension: what it does, install, version check,
// connect this browser, and the three-state setup card (TASK_PLAN.md WP-55a;
// ARCHITECTURE.md §6.3). Public page in HybridShell (R-23): the app shell with
// a session, marketing chrome and the legal footer without one. Indexed only
// when the brand has a published extension.

import type { Metadata } from 'next';

import { HybridShell } from '../../components/v3/shell/HybridShell';
import { LegalFooter } from '../../components/features/market';
import { ExtensionPage } from '../../components/features/extension';
import { getBrand } from '../../lib/brand/registry.generated';
import { getServerBrandId } from '../../lib/server/brand';
import { resolveLocale } from '../../lib/serverLocale';
import { messageAt } from '../../lib/seo';

export async function generateMetadata(): Promise<Metadata> {
  const brand = getBrand(await getServerBrandId());
  const locale = await resolveLocale(brand);
  const published = !!(brand.id === 'goapply' ? process.env.NEXT_PUBLIC_CN_EXT_ID : process.env.NEXT_PUBLIC_EXT_ID)?.trim();
  return {
    title: `${messageAt(locale, brand.id, 'extensionWeb.meta.title', brand.name)} | ${brand.name}`,
    description: messageAt(locale, brand.id, 'extensionWeb.meta.description'),
    robots: published ? { index: true, follow: true } : { index: false, follow: false },
  };
}

export default function ExtensionRoute() {
  return (
    <HybridShell from="extension" footer={<LegalFooter />}>
      <ExtensionPage />
    </HybridShell>
  );
}
