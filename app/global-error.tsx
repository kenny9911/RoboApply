'use client';

// global-error.tsx replaces the root layout entirely when an error escapes
// the App Router boundary. Must include its own <html>/<body>. Per Next.js
// docs this is the canonical override for the auto-generated /_error
// Pages Router fallback that otherwise tries to render through the root
// layout (which calls cookies() and providers — fragile under SSG).
//
// Shared theme with self-contained fallbacks when the root stylesheet fails.
//
// Language: the root layout is gone, and with it the message provider, so
// this page has its own three strings per locale
// (components/v3/shell/globalErrorCopy.ts — the `errors` strings of the nine
// bundles, copied, and held equal to them by app/errorPages.test.tsx).
//
// The first render is English (the server cannot be asked which language, and
// hydration needs the same markup); the reader's language is applied on mount
// from the `robo_locale` cookie, else the browser's languages.

import { useEffect, useState } from 'react';

import { getCookieLocale } from '../lib/locale';
import { GLOBAL_ERROR_COPY } from '../components/v3/shell/globalErrorCopy';
import { LOCALES, matchLocale, type RoboLocale } from '../lib/localeConfig';

function readerLocale(): RoboLocale {
  try {
    const fromCookie = getCookieLocale();
    if (fromCookie) return fromCookie;
    const tags = typeof navigator === 'undefined' ? [] : navigator.languages?.length ? [...navigator.languages] : [navigator.language];
    return matchLocale(tags.filter(Boolean), LOCALES) ?? 'en';
  } catch {
    return 'en';
  }
}

export default function GlobalError({
  reset,
  retry,
}: {
  error: Error & { digest?: string };
  reset: () => void;
  /** Next 16.3+: re-fetch and re-render. `reset` re-renders only. */
  retry?: () => void;
}) {
  const [locale, setLocale] = useState<RoboLocale>('en');
  useEffect(() => setLocale(readerLocale()), []);
  const copy = GLOBAL_ERROR_COPY[locale] ?? GLOBAL_ERROR_COPY.en;

  return (
    <html lang={locale}>
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '24px',
          background: 'var(--bg, #FCFCFE)',
          color: 'var(--text, #20202B)',
          fontFamily:
            "var(--font-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif)",
        }}
      >
        <div style={{ textAlign: 'center', maxWidth: '480px' }}>
          <h1
            style={{
              fontSize: '2rem',
              fontWeight: 600,
              letterSpacing: '-0.02em',
              lineHeight: 1.2,
              margin: 0,
            }}
          >
            {copy.title}
          </h1>
          <p style={{ marginTop: '12px', color: 'var(--text-2, #525162)' }}>{copy.body}</p>
          <div style={{ marginTop: '24px' }}>
            <button
              type="button"
              onClick={() => (retry ?? reset)()}
              style={{
                padding: '12px 24px',
                borderRadius: '8px',
                color: 'var(--action-ink, #FFFFFF)',
                fontFamily: 'inherit',
                fontSize: 'inherit',
                fontWeight: 600,
                background: 'var(--action, #4F3DCA)',
                boxShadow:
                  'var(--e1, 0 2px 6px rgba(32, 32, 43, 0.08))',
                border: 'none',
                cursor: 'pointer',
              }}
            >
              {copy.tryAgain}
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
