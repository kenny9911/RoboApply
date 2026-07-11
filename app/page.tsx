// Landing — public marketing, server shell.
//
// `/` is the x-default of the landing cluster: first-time visitors get the
// language their browser asks for (Accept-Language → lib/serverLocale), and
// the 8 non-EN locales live at stable `/{locale}` URLs (app/[locale]/page.tsx)
// for hreflang/SEO. The actual page UI is the client component
// components/landing/LandingContent.tsx; JSON-LD structured data is rendered
// inside it (SSR'd, one i18n source of truth).

import type { Metadata } from 'next';

import { LandingContent } from '../components/landing/LandingContent';
import { LandingJsonLd } from '../components/landing/LandingJsonLd';
import { resolveLocale } from '../lib/serverLocale';
import { landingMetadata } from '../lib/seo';

export async function generateMetadata(): Promise<Metadata> {
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
  const locale = await resolveLocale();
  return (
    <>
      <LandingJsonLd locale={locale} />
      <LandingContent />
    </>
  );
}
