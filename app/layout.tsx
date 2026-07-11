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

// Cool Graphite design language uses Geist as the primary typeface.
const geistSans = localFont({
  src: './fonts/geist-100-900.woff2',
  weight: '100 900',
  display: 'swap',
  variable: '--font-geist-sans',
});

const geistMono = localFont({
  src: './fonts/geist-mono-100-900.woff2',
  weight: '100 900',
  display: 'swap',
  variable: '--font-geist-mono',
});

// Resume-builder fonts. Loaded once at the root so the Designer-tab font
// picker can swap CSS vars on the preview without a network round-trip.
const inter = localFont({
  src: './fonts/inter-100-900.woff2',
  weight: '100 900',
  display: 'swap',
  variable: '--font-inter',
});
const poppins = localFont({
  src: [
    { path: './fonts/poppins-400.woff2', weight: '400', style: 'normal' },
    { path: './fonts/poppins-500.woff2', weight: '500', style: 'normal' },
    { path: './fonts/poppins-600.woff2', weight: '600', style: 'normal' },
    { path: './fonts/poppins-700.woff2', weight: '700', style: 'normal' },
  ],
  display: 'swap',
  variable: '--font-poppins',
});
const roboto = localFont({
  src: [
    { path: './fonts/roboto-400.woff2', weight: '400', style: 'normal' },
    { path: './fonts/roboto-500.woff2', weight: '500', style: 'normal' },
    { path: './fonts/roboto-700.woff2', weight: '700', style: 'normal' },
  ],
  display: 'swap',
  variable: '--font-roboto',
});
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

// The new 2026 RoboApply identity: Space Grotesk for chunky display + UI,
// Instrument Serif (italic) for accent words and "feel-good" pull-quotes.
const spaceGrotesk = localFont({
  src: [
    { path: './fonts/space-grotesk-400.woff2', weight: '400', style: 'normal' },
    { path: './fonts/space-grotesk-500.woff2', weight: '500', style: 'normal' },
    { path: './fonts/space-grotesk-600.woff2', weight: '600', style: 'normal' },
    { path: './fonts/space-grotesk-700.woff2', weight: '700', style: 'normal' },
  ],
  display: 'swap',
  variable: '--font-space-grotesk',
});
const instrumentSerif = localFont({
  src: [
    { path: './fonts/instrument-serif-400.woff2', weight: '400', style: 'normal' },
    { path: './fonts/instrument-serif-400-italic.woff2', weight: '400', style: 'italic' },
  ],
  display: 'swap',
  variable: '--font-instrument-serif',
});

// JetBrains Mono — the V3 mono slot: eyebrows, counts, timestamps, score
// sub-labels, kbd, salary figures. Tabular feel. Bound to --mono in globals.css.
const jetbrainsMono = localFont({
  src: [
    { path: './fonts/jetbrains-mono-400.woff2', weight: '400', style: 'normal' },
    { path: './fonts/jetbrains-mono-500.woff2', weight: '500', style: 'normal' },
    { path: './fonts/jetbrains-mono-600.woff2', weight: '600', style: 'normal' },
  ],
  display: 'swap',
  variable: '--font-jetbrains-mono',
});

export const metadata = {
  metadataBase: new URL('https://www.roboapply.io'),
  title: 'RoboApply',
  description:
    'We apply. You interview. Drop your resume, tell us what you want, and let our AI run the search overnight.',
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
      // SSR default is dark (the historical app theme). The inline script below
      // flips data-theme to the persisted preference BEFORE first paint so there
      // is no dark→light flash (FOUC). suppressHydrationWarning silences React's
      // warning about that pre-hydration mutation of the <html> attributes.
      data-theme="dark"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} ${inter.variable} ${poppins.variable} ${roboto.variable} ${sourceSans.variable} ${merriweather.variable} ${lora.variable} ${spaceGrotesk.variable} ${instrumentSerif.variable} ${jetbrainsMono.variable}`}
    >
      <head>
        {/* No-flash theme bootstrap — must run render-blocking before paint.
         * Reads the persisted dcTheme (lib/dcTheme.tsx, STORAGE_KEY
         * 'roboapply:dc-theme:v3'), and sets data-theme + color-scheme on
         * <html> so the correct palette is live on the very first frame.
         * Keep the storage key + 'theme' field in sync with lib/dcTheme.tsx. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "(function(){try{var s=localStorage.getItem('roboapply:dc-theme:v3');var t='dark';if(s){var p=JSON.parse(s);if(p&&(p.theme==='light'||p.theme==='dark'||p.theme==='warm'))t=p.theme;}var d=document.documentElement;d.setAttribute('data-theme',t);d.style.colorScheme=(t==='warm'?'light':t);}catch(e){}})();",
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
