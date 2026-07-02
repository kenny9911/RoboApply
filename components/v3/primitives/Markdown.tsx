'use client';

// Markdown — the ONLY approved way to render LLM/user markdown in V3 screens
// (cover-letter drafts, AI rewrite output, reasoning blurbs, resume body,
// transcript text, activity bodies). Wraps react-markdown with rehype-sanitize
// (strips raw HTML / XSS) + remark-gfm. NEVER use dangerouslySetInnerHTML for
// this content (CLAUDE.md project-wide rule).
//
// Two modes:
//   • inline (default): renders WITHOUT a wrapping <p> — safe to drop inside an
//     existing <p>/<span>/list item (the paragraph passes its children through).
//   • block: full block rendering (headings, lists, links) for longer bodies.
//
// Styling: inherits the surrounding text color/size; we only nudge spacing +
// link color so it reads on the dark canvas.

import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import { cn } from '../../../lib/utils';

interface Props {
  children: string;
  /** Block-level rendering (default false → inline, no wrapping <p>). */
  block?: boolean;
  className?: string;
}

const linkStyle = { color: 'var(--accent-text)', textDecoration: 'underline' } as const;

// Inline: the <p> renders as a fragment so no block-break is introduced.
const INLINE_COMPONENTS: Components = {
  p: ({ children }: { children?: ReactNode }) => <>{children}</>,
  a: ({ children, ...props }: ComponentPropsWithoutRef<'a'>) => (
    <a {...props} style={linkStyle} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
};

// Block: normal paragraphs + tidy list/heading spacing, accent links.
const BLOCK_COMPONENTS: Components = {
  p: ({ children }: { children?: ReactNode }) => (
    <p style={{ margin: '0 0 12px' }}>{children}</p>
  ),
  a: ({ children, ...props }: ComponentPropsWithoutRef<'a'>) => (
    <a {...props} style={linkStyle} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  ul: ({ children }: { children?: ReactNode }) => (
    <ul style={{ margin: '0 0 12px', paddingLeft: 20, listStyle: 'disc' }}>{children}</ul>
  ),
  ol: ({ children }: { children?: ReactNode }) => (
    <ol style={{ margin: '0 0 12px', paddingLeft: 20, listStyle: 'decimal' }}>{children}</ol>
  ),
  li: ({ children }: { children?: ReactNode }) => (
    <li style={{ marginBottom: 4 }}>{children}</li>
  ),
  strong: ({ children }: { children?: ReactNode }) => (
    <strong style={{ color: 'var(--text)', fontWeight: 600 }}>{children}</strong>
  ),
  code: ({ children }: { children?: ReactNode }) => (
    <code
      style={{
        fontFamily: 'var(--mono)',
        fontSize: '0.9em',
        background: 'var(--bg)',
        border: '1px solid var(--rule)',
        borderRadius: 4,
        padding: '1px 5px',
      }}
    >
      {children}
    </code>
  ),
};

export function Markdown({ children, block = false, className }: Props) {
  return (
    <span className={cn(block && 'v3-md-block', className)}>
      <ReactMarkdown
        rehypePlugins={[rehypeSanitize]}
        remarkPlugins={[remarkGfm]}
        components={block ? BLOCK_COMPONENTS : INLINE_COMPONENTS}
      >
        {children}
      </ReactMarkdown>
    </span>
  );
}
