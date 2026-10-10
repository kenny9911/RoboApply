// Localized home pages — `/{locale}` for every locale the request's brand
// serves (RoboApply: the 8 non-English locales plus `/en`; GoApply: `/en`).
// Stable, indexable URLs for the hreflang cluster; the proxy forwards
// `x-pathname` so the root layout resolves the SAME locale for <html lang>
// and the message bundle (lib/serverLocale.ts). A segment that is not a
// locale of this brand 404s (ARCHITECTURE.md §1.6). Opening one also stores
// its language in the robo_locale cookie (RememberLocale).
//
// `/en` on RoboApply renders English whatever the visitor's cookie or
// Accept-Language, so a link can force English (RoboHire's job-seeker link
// does). Its canonical is `/` (lib/seo.ts homePath), so search engines index
// one English document. GoApply's `/en` is reachable but not indexed
// (GoApply's SEO locale is zh only).
//
// RoboApply's localized homes carry the same live job ticker as `/`
// (app/page.tsx): its own Suspense boundary, so the page streams without it
// and a slow or failed read shows no ticker (never invented counts).

import { Suspense } from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { GoApplyHome, JsonLd, RoboApplyHome } from '../../components/features/marketing';
import { JobTicker } from '../../components/features/seo/server';
import { CN_HOME_FAQ_KEYS, HOME_FAQ_KEYS } from '../../components/features/marketing/catalog';
import { RememberLocale } from '../../components/landing/RememberLocale';
import { getBrand } from '../../lib/brand/registry.generated';
import { isLocale, isLocaleIn } from '../../lib/localeConfig';
import { getServerBrandId } from '../../lib/server/brand';
import { faqFromMessages, homeMetadata, homePath, marketingJsonLd, messageAt } from '../../lib/seo';

interface LocaleParams {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({ params }: LocaleParams): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const brand = getBrand(await getServerBrandId());
  if (!isLocaleIn(locale, brand.locales)) return {};
  return homeMetadata(brand.id, locale);
}

export default async function LocalizedLandingPage({ params }: LocaleParams) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const brand = getBrand(await getServerBrandId());
  if (!isLocaleIn(locale, brand.locales)) notFound();
  const cn = brand.market === 'cn';
  const ns = cn ? 'landing.cnHome' : 'landing.home';
  const json = marketingJsonLd({
    brandId: brand.id,
    locale,
    path: homePath(brand, locale),
    name: messageAt(locale, brand.id, `${ns}.meta.title`, brand.name),
    description: messageAt(locale, brand.id, `${ns}.meta.description`),
    faq: faqFromMessages(locale, brand.id, `${ns}.faq`, cn ? CN_HOME_FAQ_KEYS : HOME_FAQ_KEYS),
  });
  return (
    <>
      <RememberLocale locale={locale} />
      <JsonLd json={json} />
      {cn ? <GoApplyHome /> : (
        <RoboApplyHome
          ticker={
            <Suspense fallback={null}>
              <JobTicker />
            </Suspense>
          }
        />
      )}
    </>
  );
}
