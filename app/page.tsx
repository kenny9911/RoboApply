// `/` — the brand home page (TASK_PLAN.md WP-40; PRODUCT §3.2).
//
// RoboApply (roboapply.io): the gap-first home. GoApply (goapply.top): the
// 少填表、不错过截止、面试不慌 home. `/` is the x-default of each brand's
// cluster: first-time visitors get the language their browser asks for
// (Accept-Language → lib/serverLocale), the other locales live at `/{locale}`
// (app/[locale]/page.tsx). Canonical and hreflang follow the request's brand
// (lib/seo.ts homeMetadata); the JSON-LD carries a FAQPage for the FAQ the
// page renders, and never prices, ratings or reviews (D3).
//
// Both homes carry the live job ticker (F-MKT-02; D5): <JobTicker /> is a
// server component that lists the newest jobs of the request's brand that we
// may show publicly, and renders nothing when there are none (or when the
// read fails): no placeholder rows, no invented counts. It sits in its own
// Suspense boundary, so the page is sent without waiting for the job read
// (which also gives up after TICKER_TIMEOUT_MS).

import { Suspense } from 'react';
import type { Metadata } from 'next';

import { GoApplyHome, JsonLd, RoboApplyHome } from '../components/features/marketing';
import { HOME_FAQ_KEYS, cnHomeFaqKeys } from '../components/features/marketing/catalog';
import { JobTicker } from '../components/features/seo/server';
import { getBrand } from '../lib/brand/registry.generated';
import { getServerBrandId } from '../lib/server/brand';
import { resolveLocale } from '../lib/serverLocale';
import { brandUrl, faqFromMessages, homeMetadata, marketingJsonLd, messageAt } from '../lib/seo';

async function requestBrandAndLocale() {
  const brand = getBrand(await getServerBrandId());
  const locale = await resolveLocale(brand);
  return { brand, locale };
}

export async function generateMetadata(): Promise<Metadata> {
  const { brand, locale } = await requestBrandAndLocale();
  const metadata = homeMetadata(brand.id, locale);
  // `/` is the x-default document: whatever language it renders in, its
  // canonical stays the bare root so the hreflang cluster has one stable hub,
  // and it is always indexable (a crawler's Accept-Language must not noindex it).
  return {
    ...metadata,
    alternates: { ...metadata.alternates, canonical: brandUrl(brand.id, '/') },
    robots: { index: true, follow: true, 'max-image-preview': 'large' },
  };
}

export default async function LandingPage() {
  const { brand, locale } = await requestBrandAndLocale();
  const cn = brand.market === 'cn';
  const ns = cn ? 'landing.cnHome' : 'landing.home';
  const json = marketingJsonLd({
    brandId: brand.id,
    locale,
    path: '/',
    name: messageAt(locale, brand.id, `${ns}.meta.title`, brand.name),
    description: messageAt(locale, brand.id, `${ns}.meta.description`),
    // GoApply: only the questions that hold whatever the operator switched off (see cnHomeFaqKeys).
    faq: faqFromMessages(locale, brand.id, `${ns}.faq`, cn ? cnHomeFaqKeys(false) : HOME_FAQ_KEYS),
  });
  const ticker = (
    <Suspense fallback={null}>
      <JobTicker />
    </Suspense>
  );
  return (
    <>
      <JsonLd json={json} />
      {cn ? <GoApplyHome ticker={ticker} /> : <RoboApplyHome ticker={ticker} />}
    </>
  );
}
