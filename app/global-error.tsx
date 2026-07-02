'use client';

// global-error.tsx replaces the root layout entirely when an error escapes
// the App Router boundary. Must include its own <html>/<body>. Per Next.js
// docs this is the canonical override for the auto-generated /_error
// Pages Router fallback that otherwise tries to render through the root
// layout (which calls cookies() and providers — fragile under SSG).
//
// Cool Graphite palette — slate-tinted, monochrome with accent CTA.

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
            Something went wrong
          </h1>
          <p style={{ marginTop: '12px', color: '#52525b' }}>
            We&apos;ve logged the issue. Please try again.
          </p>
          <div style={{ marginTop: '24px' }}>
            <button
              type="button"
              onClick={() => reset()}
              style={{
                padding: '12px 24px',
                borderRadius: '8px',
                color: '#ffffff',
                fontWeight: 600,
                background: '#1d4ed8',
                boxShadow:
                  '0 1px 2px rgba(29, 78, 216, 0.15), 0 4px 12px rgba(29, 78, 216, 0.18)',
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
