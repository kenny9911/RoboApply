// Localized landing pages — `/zh`, `/zh-TW`, `/ja`, `/ko`, `/es`, `/fr`,
// `/pt`, `/de`. Stable, indexable URLs for the hreflang cluster; the proxy
// forwards `x-pathname` so the root layout resolves the SAME locale for
// <html lang> + the message bundle (lib/serverLocale.ts). Unknown segments 404.
//
// `/en` renders English the same way, whatever the visitor's cookie or
// Accept-Language, so a link can force English (RoboHire's job-seeker link
// does). `/` is content-negotiated and cannot. Its canonical is `/` (the
// x-default + English canonical), so search engines still index one EN
// document, and `/en` stays out of the sitemap and the hreflang cluster.

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { LandingContent } from '../../components/landing/LandingContent';
import { LandingJsonLd } from '../../components/landing/LandingJsonLd';
import { isLocale } from '../../lib/localeConfig';
import { landingMetadata } from '../../lib/seo';
import { resolveVisitorMarket } from '../../lib/serverMarket';

interface LocaleParams {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({
  params,
}: LocaleParams): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  return landingMetadata(locale);
}

export default async function LocalizedLandingPage({ params }: LocaleParams) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  // Currency follows the visitor's country, not the page's language: /zh read
  // from Taipei quotes US dollars, /en read from Shanghai quotes RMB.
  const market = await resolveVisitorMarket(locale);
  return (
    <>
      <LandingJsonLd locale={locale} market={market} />
      <LandingContent market={market} />
    </>
  );
}
