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
      className={cn('workspace-empty flex flex-col items-center justify-center text-center', className)}
      style={{
        border: '1px solid var(--rule)',
        background: 'var(--surface)',
        borderRadius: 'var(--r-lg)',
        padding: 'var(--sp-7) var(--sp-6)',
        gap: 'var(--sp-3)',
      }}
    >
      <div className="workspace-empty-icon" aria-hidden="true">
        {icon ?? <svg width="30" height="30" viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M8 25V11a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v14M5 25h22M12 13h8M12 17h5M12 21h8" /><path d="M12 8V5h8v3" /></svg>}
      </div>
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
