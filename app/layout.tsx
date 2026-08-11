// Root layout. Picks the locale + loads messages on the server, then hands
// them to the client `<Providers>` so next-intl works in both RSC and CSR.
//
// The Pages Router /404 and /500 fallback pages live at pages/404.tsx and
// pages/500.tsx so they bypass this layout entirely. The `dynamic =
// 'force-dynamic'` directive below applies to all App Router pages.

import localFont from 'next/font/local';
import type { ReactNode } from 'react';
import './globals.css';

import { loadMessages } from '../lib/i18n';
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

// ── UI type (ruling R4) ───────────────────────────────────────────────────
//
// TWO families reach the interface, and no more. The previous system loaded
// eleven and rendered three simultaneously — Space Grotesk for UI, Instrument
// Serif italic for the accent word inside almost every headline, and JetBrains
// Mono for every label, count and timestamp. That is what "the fonts are too
// random" was describing, and it was measurable: 31 distinct sizes, 8 of them
// half-pixel, 141 declarations below 12px.
//
// Inter carries 100% of read text. "Natural to users" has a precise
// typographic meaning — high x-height, open apertures, unambiguous 1/l/I, and
// a skeleton every reader has already absorbed from every operating system.
// Instrument Sans appears only on the hero and page H1, applied to the whole
// headline, never to a word inside one.
//
// Bound to --font-ui / --font-display in app/globals.css. Always reference the
// generated CSS variable: next/font emits a hashed @font-face family, so a
// literal 'Inter' in a stylesheet matches nothing and silently falls back.

const inter = localFont({
  src: './fonts/inter-100-900.woff2',
  weight: '100 900',
  display: 'swap',
  variable: '--font-inter',
});

const instrumentSans = localFont({
  src: './fonts/instrument-sans-400-700.woff2',
  weight: '400 700',
  display: 'swap',
  variable: '--font-instrument-sans',
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

export const metadata = {
  metadataBase: new URL('https://www.roboapply.io'),
  title: 'RoboApply',
  description:
    "Find out why you're not getting interviews. Drop your resume — we read 1,000+ open roles, show you the ones you can actually get, and name exactly what's missing.",
  icons: {
    icon: '/roboapply-logo.png',
    shortcut: '/roboapply-logo.png',
    apple: '/roboapply-logo.png',
  },
};

export const dynamic = 'force-dynamic';

export default async function RootLayout({
  children,
}: {
  children: ReactNode;
}) {
  const locale = await resolveLocale();
  const messages = loadMessages(locale as any);

  return (
    <html
      lang={locale}
      // Light is the default theme (ruling R3). The inline script below flips
      // data-theme to the persisted preference BEFORE first paint so there is
      // no light→dark flash (FOUC). suppressHydrationWarning silences React's
      // warning about that pre-hydration mutation of the <html> attributes.
      data-theme="light"
      suppressHydrationWarning
      className={`${inter.variable} ${instrumentSans.variable} ${sourceSans.variable} ${merriweather.variable} ${lora.variable} ${sourceHanSC.variable} ${sourceHanTW.variable}`}
    >
      <head>
        {/* No-flash theme bootstrap — must run render-blocking before paint.
         * Reads the persisted theme (lib/theme.tsx, STORAGE_KEY
         * 'roboapply:theme:v4') and sets data-theme + color-scheme on <html>
         * so the correct palette is live on the very first frame. Only 'light'
         * and 'dark' are valid — the 'warm' scope was deleted, and the v4 key
         * bump drops any persisted 'warm' so it snaps to the light default.
         * Keep the storage key + 'theme' field in sync with lib/theme.tsx. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "(function(){try{var s=localStorage.getItem('roboapply:theme:v4');var t='light';if(s){var p=JSON.parse(s);if(p&&(p.theme==='light'||p.theme==='dark'))t=p.theme;}var d=document.documentElement;d.setAttribute('data-theme',t);d.style.colorScheme=t;}catch(e){}})();",
          }}
        />
      </head>
      <body className="min-h-screen bg-bg-page text-ink-900">
        <Providers locale={locale} messages={messages}>
          {children}
        </Providers>
      </body>
    </html>
  );
}
