// Pages Router _error. Defers to Custom500 above for 5xx and Custom404 for
// 404. Required for Next.js to satisfy /_error during the static build.
//
// Cool Graphite palette — slate-tinted, monochrome with accent CTA.

import type { NextPageContext } from 'next';

interface Props {
  statusCode?: number;
}

function ErrorPage({ statusCode }: Props) {
  const title = statusCode === 404 ? '404' : 'Something went wrong';
  const body =
    statusCode === 404
      ? "We couldn't find that page."
      : "We've logged the issue. Please try again.";

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
          {title}
        </h1>
        <p style={{ marginTop: '12px', color: '#52525b' }}>{body}</p>
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

ErrorPage.getInitialProps = ({ res, err }: NextPageContext): Props => {
  const statusCode = res?.statusCode ?? err?.statusCode ?? 404;
  return { statusCode };
};

export default ErrorPage;
