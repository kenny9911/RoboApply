'use client';

// EmptyState — the "queue clear", "no results" zero-state. A centered card on
// a surface panel: optional orb/icon, a serif-accent title, a sub line, and an
// optional action slot. Used by Queue, Activity, search results, etc.

import type { ReactNode } from 'react';
import { cn } from '../../../lib/utils';

interface Props {
  /** Optional visual (an AiOrb, an Iconset glyph, an emoji span). */
  icon?: ReactNode;
  title: ReactNode;
  /** The Instrument-Serif italic accent word appended to the title. */
  accentWord?: ReactNode;
  sub?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ icon, title, accentWord, sub, action, className }: Props) {
  return (
    <div
      className={cn('flex flex-col items-center justify-center text-center', className)}
      style={{
        border: '1px solid var(--rule)',
        background: 'var(--surface)',
        borderRadius: 'var(--r-xl)',
        padding: '52px 32px',
        gap: '14px',
      }}
    >
      {icon ? <div aria-hidden="true">{icon}</div> : null}
      <h3
        style={{
          fontFamily: 'var(--sans)',
          fontSize: '22px',
          fontWeight: 600,
          letterSpacing: '-0.025em',
          color: 'var(--text)',
          margin: 0,
        }}
      >
        {title}
        {accentWord ? (
          <em
            style={{
              fontFamily: 'var(--serif)',
              fontStyle: 'italic',
              fontWeight: 400,
              color: 'var(--accent-text)',
              padding: '0 4px',
            }}
          >
            {accentWord}
          </em>
        ) : null}
      </h3>
      {sub ? (
        <p style={{ color: 'var(--text-2)', fontSize: '14px', maxWidth: 420, margin: 0 }}>
          {sub}
        </p>
      ) : null}
      {action ? <div style={{ marginTop: 6 }}>{action}</div> : null}
    </div>
  );
}
