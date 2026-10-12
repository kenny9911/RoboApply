'use client';

// Root error boundary. Catches uncaught errors thrown inside the app shell
// and renders a graceful retry surface.
//
// Kept minimal (no nested `<Link>` wrapping a `<RoboButton>` etc.) because
// the prerender path can't serialize complex children reliably.
//
// Words: the translated bundles, read through errorCopy.ts, which falls back
// to English instead of throwing — the error being shown may have come from
// the translation layer itself. Styles: inline with literal fallbacks, for
// when the root stylesheet is what failed.
//
// "Try again" calls `retry` (Next 16.3+): it re-fetches and re-renders the
// segment. `reset` only re-renders with what is already in memory, so it
// repeats a crash that came from the data. It stays as the fallback.

import { useEffect } from 'react';

import { useErrorCopy, useIsSignedIn } from '../components/v3/shell/errorCopy';
import { errorPageStyles as s } from '../components/v3/shell/errorPage.styles';

export default function RouteError({
  error,
  reset,
  retry,
}: {
  error: Error & { digest?: string };
  reset: () => void;
  retry?: () => void;
}) {
  const copy = useErrorCopy();
  const signedIn = useIsSignedIn();

  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error('[roboapply-app] uncaught error', error);
  }, [error]);

  return (
    <main style={s.wrap}>
      <div style={s.card}>
        <h1 style={s.title}>{copy('error_title')}</h1>
        <p style={s.body}>{copy('error_body')}</p>
        <div style={s.actions}>
          <button type="button" onClick={() => (retry ?? reset)()} style={s.primary}>
            {copy('try_again')}
          </button>
          {/* A plain <a>: a full page load is the point after a crash. */}
          {signedIn ? (
            <a href="/jobs" style={s.ghost}>
              {copy('go_home')}
            </a>
          ) : (
            <a href="/" style={s.ghost}>
              {copy('go_site_home')}
            </a>
          )}
        </div>
      </div>
    </main>
  );
}
