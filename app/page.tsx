// Landing — public marketing, server shell.
//
// `/` is the x-default of the landing cluster: first-time visitors get the
// language their browser asks for (Accept-Language → lib/serverLocale), and
// the 8 non-EN locales live at stable `/{locale}` URLs (app/[locale]/page.tsx)
// for hreflang/SEO. The actual page UI is the client component
// components/landing/LandingContent.tsx; JSON-LD structured data is rendered
// inside it (SSR'd, one i18n source of truth).
//
// RoboApply only, until WP-40 ships the GoApply home (D3 honesty): this
// landing claims a job feed, a live AI interviewer and 9 languages, which are
// false for GoApply (R-14 feed off by default, no voice, zh/en). On a GoApply
// host `/` goes to sign-in instead and the metadata is noindex.

import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { LandingContent } from '../components/landing/LandingContent';
import { LandingJsonLd } from '../components/landing/LandingJsonLd';
import { resolveLocale } from '../lib/serverLocale';
import { resolveVisitorMarket } from '../lib/serverMarket';
import { landingMetadata } from '../lib/seo';
import { getServerBrandId } from '../lib/server/brand';

/** The brand whose landing this is; any other brand is sent to sign-in. */
const LANDING_BRAND = 'roboapply';

export async function generateMetadata(): Promise<Metadata> {
  if ((await getServerBrandId()) !== LANDING_BRAND) return { robots: { index: false, follow: false } };
  const locale = await resolveLocale();
  const metadata = landingMetadata(locale);
  // `/` is the x-default document: whatever language it renders in, its
  // canonical stays the bare root so the hreflang cluster has one stable hub.
  return {
    ...metadata,
    alternates: { ...metadata.alternates, canonical: 'https://www.roboapply.io/' },
  };
}

export default async function LandingPage() {
  if ((await getServerBrandId()) !== LANDING_BRAND) redirect('/login');
  const locale = await resolveLocale();
  // Mainland China sees RMB, everyone else US dollars — decided per request
  // from the visitor's country, not from the language they read in.
  const market = await resolveVisitorMarket(locale);
  return (
    <>
      <LandingJsonLd locale={locale} market={market} />
      <LandingContent market={market} />
    </>
  );
}
