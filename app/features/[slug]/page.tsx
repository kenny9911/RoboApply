// /features/[slug] — feature pages per brand (TASK_PLAN.md WP-40; PRODUCT
// §3.2; F-MKT-03). The slug must belong to the request's brand (GoApply's
// extension page is /features/form-filler); anything else 404s. Gated pages
// (capability, published extension, opted-in people data) are noindex and
// render their body only once the capability is known to be on.

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { HybridShell } from '../../../components/v3/shell/HybridShell';
import { FeaturePage, JsonLd, MarketingFooter } from '../../../components/features/marketing';
import { FEATURE_FAQ_KEYS, findFeature } from '../../../components/features/marketing/catalog';
import { marketingRequest, subpageJsonLd, subpageMetadata } from '../../../components/features/marketing/serverPage';

interface SlugParams {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: SlugParams): Promise<Metadata> {
  const { slug } = await params;
  const req = await marketingRequest();
  const def = findFeature(req.brand.id, slug);
  if (!def) return { robots: { index: false, follow: false } };
  return subpageMetadata(req, `landing.features.${def.brand}.${def.key}`, `/features/${def.slug}`, { noindex: def.gate !== null });
}

export default async function FeatureRoute({ params }: SlugParams) {
  const { slug } = await params;
  const req = await marketingRequest();
  const def = findFeature(req.brand.id, slug);
  if (!def) notFound();
  const ns = `landing.features.${def.brand}.${def.key}`;
  return (
    <HybridShell from={`feature:${def.slug}`} footer={<MarketingFooter />}>
      {def.gate === null ? <JsonLd json={subpageJsonLd(req, ns, `/features/${def.slug}`, { base: ns, keys: FEATURE_FAQ_KEYS })} /> : null}
      <FeaturePage def={def} />
    </HybridShell>
  );
}
