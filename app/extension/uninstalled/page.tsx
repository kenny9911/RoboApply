// /extension/uninstalled — the page the extension opens when it is removed
// (chrome.runtime.setUninstallURL, WP-55b): an optional, anonymous survey
// (TASK_PLAN.md WP-55a). Public, in HybridShell (R-23). Never indexed.

import type { Metadata } from 'next';

import { HybridShell } from '../../../components/v3/shell/HybridShell';
import { LegalFooter } from '../../../components/features/market';
import { UninstalledPage } from '../../../components/features/extension';
import { getBrand } from '../../../lib/brand/registry.generated';
import { getServerBrandId } from '../../../lib/server/brand';
import { resolveLocale } from '../../../lib/serverLocale';
import { messageAt } from '../../../lib/seo';

export async function generateMetadata(): Promise<Metadata> {
  const brand = getBrand(await getServerBrandId());
  const locale = await resolveLocale(brand);
  return {
    title: `${messageAt(locale, brand.id, 'extensionWeb.meta.uninstalledTitle', brand.name)} | ${brand.name}`,
    robots: { index: false, follow: false },
  };
}

export default function ExtensionUninstalledRoute() {
  return (
    <HybridShell from="extension" footer={<LegalFooter />}>
      <UninstalledPage />
    </HybridShell>
  );
}
