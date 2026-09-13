// 404 fallback using the shared theme and self-contained color fallbacks.
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
            margin: 0,
          }}
        >
          That page does not exist
        </h1>
        <p style={{ marginTop: '12px', color: 'var(--text-2, #525162)' }}>
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
              color: 'var(--action-ink, #FFFFFF)',
              fontWeight: 600,
              background: 'var(--action, #4F3DCA)',
              boxShadow:
                'var(--e1, 0 2px 6px rgba(32, 32, 43, 0.08))',
            }}
          >
            Go to Jobs
          </Link>
        </div>
      </div>
    </main>
  );
}
