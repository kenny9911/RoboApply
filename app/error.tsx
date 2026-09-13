'use client';

// Root error boundary. Catches uncaught errors thrown inside the app shell
// and renders a graceful retry surface.
//
// Kept minimal (no nested `<Link>` wrapping a `<RoboButton>` etc.) because
// the prerender path can't serialize complex children reliably.
//
// Shared theme with self-contained fallbacks when the root stylesheet fails.

import { useEffect } from 'react';

const wrap: React.CSSProperties = {
  minHeight: '100vh',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '24px',
  background: 'var(--bg, #FCFCFE)',
  color: 'var(--text, #20202B)',
  fontFamily:
    "var(--font-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif)",
};

const cardStyle: React.CSSProperties = { textAlign: 'center', maxWidth: '480px' };

const titleStyle: React.CSSProperties = {
  fontSize: '2rem',
  fontWeight: 600,
  letterSpacing: '-0.02em',
  margin: 0,
};

const subStyle: React.CSSProperties = { marginTop: '12px', color: 'var(--text-2, #525162)' };

const btnPrimary: React.CSSProperties = {
  display: 'inline-block',
  padding: '12px 24px',
  borderRadius: '8px',
  color: 'var(--action-ink, #FFFFFF)',
  fontWeight: 600,
  background: 'var(--action, #4F3DCA)',
  boxShadow:
    'var(--e1, 0 2px 6px rgba(32, 32, 43, 0.08))',
  border: 'none',
  cursor: 'pointer',
};

const btnGhost: React.CSSProperties = {
  display: 'inline-block',
  padding: '12px 24px',
  borderRadius: '8px',
  color: 'var(--text-2, #525162)',
  fontWeight: 500,
  background: 'transparent',
  border: '1px solid var(--rule, #E3E0EE)',
  textDecoration: 'none',
};

export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error('[roboapply-app] uncaught error', error);
  }, [error]);

  return (
    <main style={wrap}>
      <div style={cardStyle}>
        <h1 style={titleStyle}>Something on this page failed to load</h1>
        <p style={subStyle}>
          Nothing you saved was lost. Try again, and if it keeps failing,
          reload the page.
        </p>
        <div
          style={{
            marginTop: '24px',
            display: 'flex',
            gap: '12px',
            justifyContent: 'center',
            flexWrap: 'wrap',
          }}
        >
          <button type="button" onClick={() => reset()} style={btnPrimary}>
            Try again
          </button>
          <a href="/jobs" style={btnGhost}>
            Go to Jobs
          </a>
        </div>
      </div>
    </main>
  );
}
