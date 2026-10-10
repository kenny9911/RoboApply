// `/` — the brand home page (TASK_PLAN.md WP-40; PRODUCT §3.2).
//
// RoboApply (roboapply.io): the gap-first home. GoApply (goapply.top): the
// 少填表、不错过截止、面试不慌 home. `/` is the x-default of each brand's
// cluster: first-time visitors get the language their browser asks for
// (Accept-Language → lib/serverLocale), the other locales live at `/{locale}`
// (app/[locale]/page.tsx). Canonical and hreflang follow the request's brand
// (lib/seo.ts homeMetadata); the JSON-LD carries a FAQPage for the FAQ the
// page renders, and never prices, ratings or reviews (D3).

import type { Metadata } from 'next';

import { GoApplyHome, JsonLd, RoboApplyHome } from '../components/features/marketing';
import { CN_HOME_FAQ_KEYS, HOME_FAQ_KEYS } from '../components/features/marketing/catalog';
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
    faq: faqFromMessages(locale, brand.id, `${ns}.faq`, cn ? CN_HOME_FAQ_KEYS : HOME_FAQ_KEYS),
  });
  return (
    <>
      <JsonLd json={json} />
      {cn ? <GoApplyHome /> : <RoboApplyHome />}
    </>
  );
}
