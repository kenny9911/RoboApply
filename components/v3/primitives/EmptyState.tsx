'use client';

// EmptyState — the "queue clear", "no results" zero-state. A centered card on
// a surface panel: optional orb/icon, a title, a sub line, and an optional
// action slot. Used by Queue, Activity, search results, etc.
//
// The title is one continuous string in one family (ruling R4); the old
// `accentWord` prop that wrapped a trailing word in italic serif is gone.

import type { ReactNode } from 'react';
import { cn } from '../../../lib/utils';

interface Props {
  /** Optional visual (an Iconset glyph). */
  icon?: ReactNode;
  title: ReactNode;
  sub?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ icon, title, sub, action, className }: Props) {
  return (
    <div
      className={cn('flex flex-col items-center justify-center text-center', className)}
      style={{
        border: '1px solid var(--rule)',
        background: 'var(--surface)',
        borderRadius: 'var(--r-lg)',
        padding: 'var(--sp-7) var(--sp-6)',
        gap: 'var(--sp-3)',
      }}
    >
      {icon ? <div aria-hidden="true">{icon}</div> : null}
      <h3
        style={{
          fontSize: 'var(--fs-title)',
          fontWeight: 600,
          lineHeight: 'var(--lh-title)',
          letterSpacing: 'var(--ls-title)',
          color: 'var(--text)',
          margin: 0,
        }}
      >
        {title}
      </h3>
      {sub ? (
        <p style={{ color: 'var(--text-2)', fontSize: 'var(--fs-body)', maxWidth: 420, margin: 0 }}>
          {sub}
        </p>
      ) : null}
      {action ? <div style={{ marginTop: 'var(--sp-2)' }}>{action}</div> : null}
    </div>
  );
}
