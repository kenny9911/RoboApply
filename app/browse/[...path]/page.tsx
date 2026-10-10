// /browse/[...path] — programmatic job lists from live inventory (TASK_PLAN.md
// WP-56; F-SEO-01/02/04/06/07, F-TOOL-05). One catch-all route parses:
//   /browse/{role}, /browse/{role}/{city}, /browse/remote/{role},
//   /browse/visa-sponsorship/{country}/{role}, /browse/entry-level,
//   /browse/internships, /browse/graduate/{role}   (+ `?country=XX`)
// Data: lib/server/publicApi.ts (unstable_cache per brand × type × slug,
// tag `seo:<brand>:<type>:<slug>`). A non-canonical path (free-text role,
// `_` slug) 301s to the canonical one. Below the indexability floor, and on
// `?country=` views, the page is noindex. GoApply: deferred → 404. Feature
// flag `seo.browse` off → 404. An unknown role (or a known role in an
// unknown city) renders a noindex page that names what we could not find and
// points at the real lists. Public page in HybridShell (R-23); the
// VisitorFeed (WP-78) renders under the server list. Reads forward the
// visitor's IP on cache misses (the API's per-IP limit, F-TRUST-02).

import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';

import { HybridShell } from '../../../components/v3/shell/HybridShell';
import { LegalFooter } from '../../../components/features/market';
import { JsonLd } from '../../../components/features/marketing';
import { BrowsePage, BrowseUnknown } from '../../../components/features/seo';
import { browseJsonLd, browseMetadata, seoRequest } from '../../../components/features/seo/server';
import { VisitorFeed } from '../../../components/features/visitor';
import { browseUnknownQuery, type BrowseUnknownQuery } from '../../../lib/seo';
import { loadBrowseHub, loadBrowsePage } from '../../../lib/server/publicApi';
import type { SeoPageResponse } from '../../../lib/api/contracts/seo';

interface BrowseProps {
  params: Promise<{ path: string[] }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

type Loaded =
  | { kind: 'page'; data: SeoPageResponse }
  | { kind: 'unknown'; query: BrowseUnknownQuery }
  | { kind: 'missing' };

async function load({ params, searchParams }: BrowseProps): Promise<Loaded> {
  const { path } = await params;
  const sp = (await searchParams) ?? {};
  const req = await seoRequest();
  if (req.brand.market === 'cn') return { kind: 'missing' };
  const country = typeof sp.country === 'string' ? sp.country : null;
  const pending = loadBrowsePage(req.brand.id, path ?? [], country, { clientIp: req.clientIp });
  if (!pending) return { kind: 'missing' };
  const res = await pending;
  if (res.status === 'ok') return { kind: 'page', data: res.data };
  const query = res.status === 'not_found' ? browseUnknownQuery(path ?? [], res.reason) : null;
  return query ? { kind: 'unknown', query } : { kind: 'missing' };
}

export async function generateMetadata(props: BrowseProps): Promise<Metadata> {
  const loaded = await load(props);
  if (loaded.kind !== 'page') return { robots: { index: false, follow: true } };
  return browseMetadata(await seoRequest(), loaded.data);
}

export default async function BrowsePathPage(props: BrowseProps) {
  const loaded = await load(props);
  if (loaded.kind === 'missing') notFound();
  if (loaded.kind === 'unknown') {
    const req = await seoRequest();
    const hub = await loadBrowseHub(req.brand.id, { clientIp: req.clientIp }).catch(() => null);
    return (
      <HybridShell from="browse" footer={<LegalFooter />}>
        <BrowseUnknown query={loaded.query} links={hub?.status === 'ok' ? hub.data.pages.slice(0, 24) : []} />
        <VisitorFeed from="browse" query={{ role: loaded.query.role }} />
      </HybridShell>
    );
  }
  const { data } = loaded;
  if (data.redirect) permanentRedirect(data.country ? `${data.path}?country=${data.country}` : data.path);
  const req = await seoRequest();
  return (
    <HybridShell from="browse" footer={<LegalFooter />}>
      <JsonLd json={browseJsonLd(req, data)} />
      <BrowsePage data={data} signupHref={`/signup?from=${encodeURIComponent(`browse:${data.type}`)}`} />
      <VisitorFeed
        from="browse"
        query={{
          ...(data.role ? { role: data.role.label } : {}),
          ...(data.city ? { city: data.city.name, country: data.city.country } : {}),
          ...(data.country ? { country: data.country } : {}),
        }}
      />
    </HybridShell>
  );
}
