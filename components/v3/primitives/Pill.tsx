'use client';

// Pill — a small accent mono pill (the prototype's `.pill` inside queue heads:
// "92% fit"). Self-contained so screens can drop it anywhere, not just under a
// `.queue-head .co`. Tones reuse the tag palette.

import type { ReactNode } from 'react';

export type PillTone = 'accent' | 'violet' | 'warn' | 'ok' | 'muted';

const TONE_STYLE: Record<PillTone, { bg: string; color: string; border: string }> = {
  accent: { bg: 'var(--accent-soft)', color: 'var(--accent-text)', border: 'var(--accent-text)' },
  violet: { bg: 'var(--violet-soft)', color: 'var(--violet)', border: 'var(--violet)' },
  warn: { bg: 'var(--warn-soft)', color: 'var(--warn)', border: 'var(--warn)' },
  ok: { bg: 'var(--ok-soft)', color: 'var(--ok)', border: 'var(--ok)' },
  muted: { bg: 'var(--surface-2)', color: 'var(--text-2)', border: 'var(--rule)' },
};

interface Props {
  tone?: PillTone;
  children: ReactNode;
  className?: string;
}

export function Pill({ tone = 'accent', children, className }: Props) {
  const s = TONE_STYLE[tone];
  return (
    <span
      className={className}
      style={{
        fontFamily: 'var(--mono)',
        fontSize: '10.5px',
        fontWeight: 600,
        padding: '3px 8px',
        borderRadius: '99px',
        background: s.bg,
        color: s.color,
        border: `1px solid ${s.border}`,
        letterSpacing: 0,
        display: 'inline-flex',
        alignItems: 'center',
        gap: '5px',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  );
}
