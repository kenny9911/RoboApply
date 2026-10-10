// /browse — the hub of job lists (TASK_PLAN.md WP-56; ruling C26: the
// marketing footer's "Popular job lists" and the quick search land under
// /browse). Lists come from `seo-rebuild` (indexable pages only, real
// counts). GoApply: deferred → 404; flag `seo.browse` off → 404.

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { HybridShell } from '../../components/v3/shell/HybridShell';
import { LegalFooter } from '../../components/features/market';
import { BrowseHub } from '../../components/features/seo';
import { seoRequest, seoTranslator } from '../../components/features/seo/server';
import { publicPageMetadata } from '../../lib/seo';
import { loadBrowseHub } from '../../lib/server/publicApi';

export async function generateMetadata(): Promise<Metadata> {
  const req = await seoRequest();
  const t = seoTranslator(req);
  return publicPageMetadata({
    brandId: req.brand.id,
    path: '/browse',
    title: `${t('browse.hub.title')} | ${req.brand.name}`,
    description: t('browse.hub.sub'),
    indexable: req.brand.market !== 'cn',
  });
}

export default async function BrowseHubPage() {
  const req = await seoRequest();
  if (req.brand.market === 'cn') notFound();
  const res = await loadBrowseHub(req.brand.id, { clientIp: req.clientIp });
  if (res.status !== 'ok') notFound();
  return (
    <HybridShell from="browse" footer={<LegalFooter />}>
      <BrowseHub links={res.data.pages} />
    </HybridShell>
  );
}
