// Localized landing pages — `/zh`, `/zh-TW`, `/ja`, `/ko`, `/es`, `/fr`,
// `/pt`, `/de`. Stable, indexable URLs for the hreflang cluster; the proxy
// forwards `x-pathname` so the root layout resolves the SAME locale for
// <html lang> + the message bundle (lib/serverLocale.ts). `/en` redirects
// to `/` (the x-default + English canonical) so no duplicate EN document
// exists. Unknown segments 404.

import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';

import { LandingContent } from '../../components/landing/LandingContent';
import { LandingJsonLd } from '../../components/landing/LandingJsonLd';
import { DEFAULT_LOCALE, isLocale } from '../../lib/localeConfig';
import { landingMetadata } from '../../lib/seo';
import { resolveVisitorMarket } from '../../lib/serverMarket';

interface LocaleParams {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({
  params,
}: LocaleParams): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale) || locale === DEFAULT_LOCALE) return {};
  return landingMetadata(locale);
}

export default async function LocalizedLandingPage({ params }: LocaleParams) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  if (locale === DEFAULT_LOCALE) permanentRedirect('/');
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
