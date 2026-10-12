// /tools/job-alerts — logged-out job alerts (WP-78; F-NOTIF-03, F-TOOL-04).
//
// A static route beside /tools/[tool] (WP-57), so Next.js matches it first.
// Public page in HybridShell (R-23) with the site footer, like the other free
// tools. The form prefills from `?role=&city=&country=` (the visitor feed's
// "Get new jobs like these by email" link). Both brands (D5). Where alerts
// are off (FLAG_<BRAND>_JOBS_ALERTS=false, GoApply with
// CN_RECRUITMENT_INFO_MODE=off, or no email transport) the form says it is
// not available here; the page is indexed while the brand's `jobs.alerts`
// capability is on (the same rule lists it in /sitemaps/static.xml).

import type { Metadata } from 'next';

import { HybridShell } from '../../../components/v3/shell/HybridShell';
import { MarketingFooter } from '../../../components/features/marketing';
import { JobAlertsForm } from '../../../components/features/visitor';
import { getBrand } from '../../../lib/brand/registry.generated';
import { getServerBrandId } from '../../../lib/server/brand';
import { resolveLocale } from '../../../lib/serverLocale';
import { alertsSurfaceOn, marketingMetadata, messageAt } from '../../../lib/seo';
import { loadSitemapIndex } from '../../../lib/server/publicApi';

type Props = { searchParams?: Promise<Record<string, string | string[] | undefined>> };

const one = (v: string | string[] | undefined, max: number): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

export async function generateMetadata(): Promise<Metadata> {
  const brand = getBrand(await getServerBrandId());
  const locale = await resolveLocale(brand);
  const surfaces = await loadSitemapIndex(brand.id)
    .then((r) => (r.status === 'ok' ? r.data.surfaces : null))
    .catch(() => null);
  return marketingMetadata({
    brandId: brand.id,
    locale,
    path: '/tools/job-alerts',
    title: `${messageAt(locale, brand.id, 'visitor.alerts.meta.title', brand.name)} | ${brand.name}`,
    description: messageAt(locale, brand.id, 'visitor.alerts.meta.description'),
    noindex: !alertsSurfaceOn(surfaces),
  });
}

export default async function JobAlertsPage({ searchParams }: Props) {
  const sp = (await searchParams) ?? {};
  const country = one(sp.country, 3)?.toUpperCase();
  return (
    <HybridShell from="tools" footer={<MarketingFooter />}>
      <JobAlertsForm initial={{ role: one(sp.role, 120), city: one(sp.city, 80), country: country && /^[A-Z]{2}$/.test(country) ? country : undefined }} />
    </HybridShell>
  );
}
