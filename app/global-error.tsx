'use client';

// global-error.tsx replaces the root layout entirely when an error escapes
// the App Router boundary. Must include its own <html>/<body>. Per Next.js
// docs this is the canonical override for the auto-generated /_error
// Pages Router fallback that otherwise tries to render through the root
// layout (which calls cookies() and providers — fragile under SSG).
//
// Shared theme with self-contained fallbacks when the root stylesheet fails.

export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
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
              margin: 0,
            }}
          >
            Something on this page failed to load
          </h1>
          <p style={{ marginTop: '12px', color: 'var(--text-2, #525162)' }}>
            Nothing you saved was lost. Try again, and if it keeps failing,
            reload the page.
          </p>
          <div style={{ marginTop: '24px' }}>
            <button
              type="button"
              onClick={() => reset()}
              style={{
                padding: '12px 24px',
                borderRadius: '8px',
                color: 'var(--action-ink, #FFFFFF)',
                fontWeight: 600,
                background: 'var(--action, #4F3DCA)',
                boxShadow:
                  'var(--e1, 0 2px 6px rgba(32, 32, 43, 0.08))',
                border: 'none',
                cursor: 'pointer',
              }}
            >
              Try again
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
