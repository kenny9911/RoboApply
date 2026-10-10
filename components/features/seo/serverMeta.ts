// components/features/seo/serverMeta.ts — SERVER-ONLY metadata and JSON-LD
// for the public SEO routes (app/browse/**, app/job/**). Pulls the message
// bundles (lib/i18n via lib/seo), so it is exported from './server' only.

import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { createTranslator } from 'next-intl';

import { getBrand, type ProductBrand } from '../../../lib/brand/registry.generated';
import type { RoboLocale } from '../../../lib/localeConfig';
import { loadMessages } from '../../../lib/i18n';
import { breadcrumbNode, jobPostingNode, jsonLdGraph, publicPageMetadata } from '../../../lib/seo';
import type { PublicJobDetail, SeoPageResponse } from '../../../lib/api/contracts/seo';
import { getServerBrandId } from '../../../lib/server/brand';
import { visitorIpFrom } from '../../../lib/server/publicApi';
import { resolveLocale } from '../../../lib/serverLocale';
import { browseTitle } from './names';

export interface SeoRequest {
  brand: ProductBrand;
  locale: RoboLocale;
  /** The visitor's IP, forwarded on cache misses so the API's per-IP limit counts the visitor (F-TRUST-02). */
  clientIp: string | null;
}

async function requestClientIp(): Promise<string | null> {
  try {
    const h = await headers();
    return visitorIpFrom((name) => h.get(name));
  } catch {
    return null; // outside a request (prerender)
  }
}

export async function seoRequest(): Promise<SeoRequest> {
  const brand = getBrand(await getServerBrandId());
  const [locale, clientIp] = await Promise.all([resolveLocale(brand), requestClientIp()]);
  return { brand, locale, clientIp };
}

/** `seo.*` translator for the request's brand × locale (ICU, `%BRAND%` substituted). */
export function seoTranslator(req: SeoRequest) {
  return createTranslator({ locale: req.locale, messages: loadMessages(req.locale, req.brand.id) as never, namespace: 'seo' as never }) as unknown as (
    key: string,
    params?: Record<string, string | number>,
  ) => string;
}

export function browsePageTitle(req: SeoRequest, data: SeoPageResponse): string {
  const t = seoTranslator(req);
  const { key, params } = browseTitle(data, req.locale);
  return t(`browse.title.${key}`, params);
}

/** Canonical = the page's canonical path (never the `?country=` view); noindex below the floor. */
export function browseMetadata(req: SeoRequest, data: SeoPageResponse): Metadata {
  const t = seoTranslator(req);
  const title = browsePageTitle(req, data);
  return publicPageMetadata({
    brandId: req.brand.id,
    path: data.path,
    title: `${title} | ${req.brand.name}`,
    description: t('browse.metaDescription', { count: data.stats.jobCount.value }),
    indexable: data.indexable,
  });
}

export function browseJsonLd(req: SeoRequest, data: SeoPageResponse): string {
  const t = seoTranslator(req);
  return jsonLdGraph([
    breadcrumbNode(req.brand.id, [
      { name: t('breadcrumb.home'), path: '/' },
      { name: t('breadcrumb.browse'), path: '/browse' },
      { name: browsePageTitle(req, data), path: data.path },
    ]),
  ]);
}

export function jobMetadata(req: SeoRequest, job: PublicJobDetail): Metadata {
  const t = seoTranslator(req);
  return publicPageMetadata({
    brandId: req.brand.id,
    path: job.canonicalPath,
    title: `${t('job.metaTitle', { title: job.title, company: job.company.name })} | ${req.brand.name}`,
    description: t('job.metaDescription', { title: job.title, company: job.company.name }),
    indexable: true,
  });
}

/** JobPosting + BreadcrumbList (only ever built for a public, open job). */
export function jobJsonLd(req: SeoRequest, job: PublicJobDetail): string {
  const t = seoTranslator(req);
  return jsonLdGraph([
    jobPostingNode(job, req.brand.id),
    breadcrumbNode(req.brand.id, [
      { name: t('breadcrumb.home'), path: '/' },
      { name: job.title, path: job.canonicalPath },
    ]),
  ]);
}
