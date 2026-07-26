// 404 fallback. Minimal Cool Graphite styling so the page doesn't look like
// a stock Next.js error screen.
//
// IMPORTANT: this file is rendered at build time as a STATIC page. It
// cannot use cookies(), headers(), next-intl client provider, or anything
// else that requires the dynamic per-request layout context.

import Link from 'next/link';

export default function NotFound() {
  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
        background: '#fafafa',
        color: '#09090b',
        fontFamily:
          "'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
      }}
    >
      <div style={{ textAlign: 'center', maxWidth: '480px' }}>
        <h1
          style={{
            fontSize: '2rem',
            fontWeight: 600,
            letterSpacing: '-0.02em',
            margin: 0,
          }}
        >
          That page does not exist
        </h1>
        <p style={{ marginTop: '12px', color: '#52525b' }}>
          The address may be wrong, or the page may have moved. Go to your
          jobs and start from there.
        </p>
        <div style={{ marginTop: '24px' }}>
          <Link
            href="/jobs"
            style={{
              display: 'inline-block',
              padding: '12px 24px',
              borderRadius: '8px',
              color: '#ffffff',
              fontWeight: 600,
              background: '#1d4ed8',
              boxShadow:
                '0 1px 2px rgba(29, 78, 216, 0.15), 0 4px 12px rgba(29, 78, 216, 0.18)',
            }}
          >
            Go to Jobs
          </Link>
        </div>
      </div>
    </main>
  );
}
