// Localized landing pages — `/zh`, `/zh-TW`, `/ja`, `/ko`, `/es`, `/fr`,
// `/pt`, `/de`. Stable, indexable URLs for the hreflang cluster; the proxy
// forwards `x-pathname` so the root layout resolves the SAME locale for
// <html lang> + the message bundle (lib/serverLocale.ts). Unknown segments 404.
// Opening one also stores its language in the robo_locale cookie
// (RememberLocale), so the pages that follow stay in that language.
//
// `/en` renders English the same way, whatever the visitor's cookie or
// Accept-Language, so a link can force English (RoboHire's job-seeker link
// does). `/` is content-negotiated and cannot. Its canonical is `/` (the
// x-default + English canonical), so search engines still index one EN
// document, and `/en` stays out of the sitemap and the hreflang cluster.
//
// RoboApply only, until WP-40 ships the GoApply home (D3 honesty; see
// app/page.tsx): on a GoApply host these redirect to sign-in.

import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';

import { LandingContent } from '../../components/landing/LandingContent';
import { LandingJsonLd } from '../../components/landing/LandingJsonLd';
import { RememberLocale } from '../../components/landing/RememberLocale';
import { isLocale } from '../../lib/localeConfig';
import { landingMetadata } from '../../lib/seo';
import { resolveVisitorMarket } from '../../lib/serverMarket';
import { getServerBrandId } from '../../lib/server/brand';

interface LocaleParams {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({
  params,
}: LocaleParams): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  if ((await getServerBrandId()) !== 'roboapply') return { robots: { index: false, follow: false } };
  return landingMetadata(locale);
}

export default async function LocalizedLandingPage({ params }: LocaleParams) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  if ((await getServerBrandId()) !== 'roboapply') redirect('/login');
  // Currency follows the visitor's country, not the page's language: /zh read
  // from Taipei quotes US dollars, /en read from Shanghai quotes RMB.
  const market = await resolveVisitorMarket(locale);
  return (
    <>
      <RememberLocale locale={locale} />
      <LandingJsonLd locale={locale} market={market} />
      <LandingContent market={market} />
    </>
  );
}
