// Root layout. Resolves the request's product brand (lib/server/brand.ts,
// from the proxy's x-ra-brand), picks the locale (clamped to the brand's
// locales) and the brand's message bundle, which reaches the client
// `<Providers>` as a cached script of its own (lib/i18nBundle.ts) rather than
// as a prop serialized into every page.
//
// Per brand (ARCHITECTURE.md §1.5): `<html data-brand>`, generateMetadata()
// (metadataBase, title, icons, Baidu verification), generateViewport()
// (theme colors), the `%BRAND%` substitution in loadMessages, and two root
// slots — the wrong-market nudge (WP-12) and the analytics consent banner
// (WP-23) — mounted once here.
//
// The Pages Router /404 and /500 fallback pages live at pages/404.tsx and
// pages/500.tsx so they bypass this layout entirely. The `dynamic =
// 'force-dynamic'` directive below applies to all App Router pages.

import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import Script from 'next/script';
import type { ReactNode } from 'react';
import './globals.css';

import { WrongBrandNudge } from '../components/features/brand/WrongBrandNudge';
import { AnalyticsConsent } from '../components/features/growth/AnalyticsConsent';
import { ThemeBootScript } from '../components/v3/shell/ThemeBootScript';
import { publicBrand } from '../lib/brand/client';
import { buildRootMetadata, buildRootViewport } from '../lib/brand/metadata';
import { getRequestCountry, getServerBrand } from '../lib/server/brand';
import { messagesBundle } from '../lib/server/messagesBundle';
import { resolveLocale } from '../lib/serverLocale';
import { Providers } from './providers';

// Fonts are SELF-HOSTED via `next/font/local` (woff2 in ./fonts/, downloaded
// from Google Fonts' latin subset by ./fonts/_download.py). This removes the
// build-time network dependency on fonts.gstatic.com — `next/font/google`
// fetches each face at build time and a single failed fetch aborts the whole
// Turbopack build ("Module not found: @vercel/turbopack-next/.../font"). The
// `--font-*` CSS variable names are unchanged, so styles/tokens.css and the
// resume-builder font picker keep working with no other edits. CJK glyphs were
// never covered by these latin fonts (subsets:['latin']) — they fall back to
// system fonts as before.

// The interface is set in two self-hosted variable faces (the Pulse system,
// docs/design-system.md): DM Sans (weights 100–1000, with its optical-size
// axis) for everything that is read, and Space Grotesk (300–700) for
// headlines. Inter (Desk) and Bricolage Grotesque (Paper) stay declared for
// anything that still names their variables, but are no longer preloaded.
const dmSans = localFont({
  src: './fonts/dm-sans-100-1000.woff2',
  weight: '100 1000',
  display: 'swap',
  variable: '--font-dm-sans',
});

const spaceGrotesk = localFont({
  src: './fonts/space-grotesk-300-700.woff2',
  weight: '300 700',
  display: 'swap',
  variable: '--font-space-grotesk',
});

const inter = localFont({
  src: './fonts/inter-100-900.woff2',
  weight: '100 900',
  display: 'swap',
  variable: '--font-inter',
  preload: false,
});

const bricolage = localFont({
  src: './fonts/bricolage-grotesque-200-800.woff2',
  weight: '200 800',
  display: 'swap',
  variable: '--font-bricolage',
  preload: false,
});

// ── Résumé document type ──────────────────────────────────────────────────
// These are NOT UI fonts. They exist so the Designer tab can restyle the
// résumé the user is about to send to an employer, where choosing your own
// typography is legitimate. Four options (was eight); Inter is the default.
const sourceSans = localFont({
  src: './fonts/source-sans-3-200-900.woff2',
  weight: '200 900',
  display: 'swap',
  variable: '--font-source-sans',
});
const merriweather = localFont({
  src: [
    { path: './fonts/merriweather-400.woff2', weight: '400', style: 'normal' },
    { path: './fonts/merriweather-700.woff2', weight: '700', style: 'normal' },
  ],
  display: 'swap',
  variable: '--font-merriweather',
});
const lora = localFont({
  src: './fonts/lora-400-700.woff2',
  weight: '400 700',
  display: 'swap',
  variable: '--font-lora',
});

// ── CJK — Source Han Sans (思源黑體) ──────────────────────────────────────
// Self-hosted from adobe-fonts/source-han-sans (release branch, variable
// WOFF2 region subsets; SIL OFL 1.1 — ./fonts/LICENSE-SourceHanSans.txt).
// CN carries simplified (zh); TW carries traditional with Taiwan MOE glyph
// standards (zh-TW). NOT preloaded: these are multi-MB faces that only
// zh/zh-TW pages reference — globals.css slots them into --font-ui via
// <html lang>, so other locales never download them.
const sourceHanSC = localFont({
  src: './fonts/source-han-sans-cn-vf.woff2',
  weight: '250 900',
  display: 'swap',
  preload: false,
  variable: '--font-source-han-sc',
});
const sourceHanTW = localFont({
  src: './fonts/source-han-sans-tw-vf.woff2',
  weight: '250 900',
  display: 'swap',
  preload: false,
  variable: '--font-source-han-tw',
});

// Per-brand head metadata (lib/brand/metadata.ts). RoboApply's output is the
// same as the former static export (plus applicationName and theme colors).
export async function generateMetadata(): Promise<Metadata> {
  return buildRootMetadata(await getServerBrand());
}

export async function generateViewport(): Promise<Viewport> {
  return buildRootViewport(await getServerBrand());
}

export const dynamic = 'force-dynamic';

export default async function RootLayout({
  children,
}: {
  children: ReactNode;
}) {
  const brand = await getServerBrand();
  const locale = await resolveLocale(brand);
  // The messages travel as their own cached script, not inside this page's
  // HTML (lib/i18nBundle.ts): about 500 KB less on every full page load.
  const messages = messagesBundle(locale, brand.id);
  const country = await getRequestCountry();

  return (
    <html
      lang={locale}
      // Brand scope for CSS (styles/brands/<brand>.css overrides identity and
      // action tokens under html[data-brand='goapply']) and for tests.
      data-brand={brand.id}
      // Light is the default theme (ruling R3). The inline script below flips
      // data-theme to the persisted preference BEFORE first paint so there is
      // no light→dark flash (FOUC). suppressHydrationWarning silences React's
      // warning about that pre-hydration mutation of the <html> attributes.
      data-theme="light"
      suppressHydrationWarning
      className={`${dmSans.variable} ${spaceGrotesk.variable} ${inter.variable} ${bricolage.variable} ${sourceSans.variable} ${merriweather.variable} ${lora.variable} ${sourceHanSC.variable} ${sourceHanTW.variable}`}
    >
      <head>
        {/* No-flash theme bootstrap — must run render-blocking before paint.
         * Reads the persisted theme (lib/theme.tsx, STORAGE_KEY
         * 'roboapply:theme:v4') and sets data-theme + color-scheme on <html>
         * so the correct palette is live on the very first frame. A component,
         * not a bare <script>: a 404 renders this layout in the browser, where
         * React reports (and never runs) a script it creates — see
         * components/v3/shell/ThemeBootScript.tsx. */}
        <ThemeBootScript />
        {/* Next's bootstrap loads beforeInteractive scripts before it hydrates. */}
        <Script src={messages.url} strategy="beforeInteractive" />
      </head>
      <body className="min-h-screen bg-bg-page text-ink-900">
        <Providers locale={locale} messagesKey={messages.key} messagesUrl={messages.url} brand={publicBrand(brand)}>
          <WrongBrandNudge country={country} locale={locale} />
          {children}
          <AnalyticsConsent country={country} />
        </Providers>
      </body>
    </html>
  );
}
