// Pages Router shadow of app/global-error.tsx. Renders when Next falls back
// to /500 — pure HTML, no providers, no next-intl.
//
// Cool Graphite palette — slate-tinted, monochrome with accent CTA.

export default function Custom500() {
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
          Something went wrong
        </h1>
        <p style={{ marginTop: '12px', color: '#52525b' }}>
          We&apos;ve logged the issue. Please try again.
        </p>
        <div style={{ marginTop: '24px' }}>
          <a
            href="/"
            style={{
              display: 'inline-block',
              padding: '12px 24px',
              borderRadius: '8px',
              color: '#ffffff',
              fontWeight: 600,
              background: '#1d4ed8',
              boxShadow:
                '0 1px 2px rgba(29, 78, 216, 0.15), 0 4px 12px rgba(29, 78, 216, 0.18)',
              textDecoration: 'none',
            }}
          >
            Go home
          </a>
        </div>
      </div>
    </main>
  );
}
