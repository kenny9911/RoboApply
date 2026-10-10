// Inline styles shared by the 404 page and the route error boundary.
//
// Inline, with a literal fallback after every token, on purpose: these two
// screens must still look like the product when the stylesheet is the thing
// that failed to load. The values are the Clarity tokens (app/globals.css);
// the literals are their light-theme values.

import type { CSSProperties } from 'react';

export const errorPageStyles = {
  wrap: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '24px',
    background: 'var(--bg, #FCFCFE)',
    color: 'var(--text, #20202B)',
    fontFamily: "var(--font-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif)",
  },
  card: { textAlign: 'center', maxWidth: '480px' },
  title: { fontSize: '2rem', fontWeight: 600, letterSpacing: '-0.02em', lineHeight: 1.2, margin: 0 },
  body: { marginTop: '12px', color: 'var(--text-2, #525162)' },
  actions: { marginTop: '24px', display: 'flex', gap: '12px', justifyContent: 'center', flexWrap: 'wrap' },
  primary: {
    display: 'inline-block',
    padding: '12px 24px',
    borderRadius: '8px',
    color: 'var(--action-ink, #FFFFFF)',
    fontFamily: 'inherit',
    fontSize: 'inherit',
    fontWeight: 600,
    background: 'var(--action, #4F3DCA)',
    boxShadow: 'var(--e1, 0 2px 6px rgba(32, 32, 43, 0.08))',
    border: 'none',
    cursor: 'pointer',
    textDecoration: 'none',
  },
  ghost: {
    display: 'inline-block',
    padding: '12px 24px',
    borderRadius: '8px',
    color: 'var(--text-2, #525162)',
    fontWeight: 500,
    background: 'transparent',
    border: '1px solid var(--rule, #E2DFED)',
    textDecoration: 'none',
  },
} satisfies Record<string, CSSProperties>;
