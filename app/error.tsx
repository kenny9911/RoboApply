'use client';

// Root error boundary. Catches uncaught errors thrown inside the app shell
// and renders a graceful retry surface.
//
// Kept minimal (no nested `<Link>` wrapping a `<RoboButton>` etc.) because
// the prerender path can't serialize complex children reliably.
//
// Cool Graphite palette — slate-tinted, monochrome with accent CTA.

import { useEffect } from 'react';

const wrap: React.CSSProperties = {
  minHeight: '100vh',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '24px',
  background: '#fafafa',
  color: '#09090b',
  fontFamily:
    "'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
};

const cardStyle: React.CSSProperties = { textAlign: 'center', maxWidth: '480px' };

const titleStyle: React.CSSProperties = {
  fontSize: '2rem',
  fontWeight: 600,
  letterSpacing: '-0.02em',
  margin: 0,
};

const subStyle: React.CSSProperties = { marginTop: '12px', color: '#52525b' };

const btnPrimary: React.CSSProperties = {
  display: 'inline-block',
  padding: '12px 24px',
  borderRadius: '8px',
  color: '#ffffff',
  fontWeight: 600,
  background: '#1d4ed8',
  boxShadow:
    '0 1px 2px rgba(29, 78, 216, 0.15), 0 4px 12px rgba(29, 78, 216, 0.18)',
  border: 'none',
  cursor: 'pointer',
};

const btnGhost: React.CSSProperties = {
  display: 'inline-block',
  padding: '12px 24px',
  borderRadius: '8px',
  color: '#27272a',
  fontWeight: 500,
  background: 'transparent',
  border: '1px solid #e4e4e7',
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
        <h1 style={titleStyle}>Something went wrong</h1>
        <p style={subStyle}>
          We&apos;ve logged the issue. You can try again or head back home.
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
          <a href="/" style={btnGhost}>
            Go home
          </a>
        </div>
      </div>
    </main>
  );
}
