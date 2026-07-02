// Pages Router shadow of the App Router /not-found.tsx. Next.js needs both
// for the static prerender pass to succeed when the App Router root layout
// uses `dynamic = 'force-dynamic'` (which prevents app/not-found.tsx from
// being prerendered as truly static). Keeping the Pages Router 404 in
// parallel sidesteps that and renders cleanly on Render.
//
// Identical visual content to app/not-found.tsx, but pure HTML with no
// Next/Link or next-intl dependency — must work without the providers.
//
// Cool Graphite palette — slate-tinted, monochrome with accent CTA.

export default function Custom404() {
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
          404
        </h1>
        <p style={{ marginTop: '12px', color: '#52525b' }}>
          We couldn&apos;t find that page.
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
