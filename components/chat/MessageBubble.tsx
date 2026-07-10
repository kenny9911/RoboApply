'use client';

// MessageBubble — the conversational surface from the Teal-UI §3.8 pattern.
// Two variants:
//   - role="ai":   surface card on ink-line-soft, no avatar, left-aligned
//                  (this is the dominant mode in application detail)
//   - role="user": teal-50 bg, right-aligned, max 560px
// Both backgrounds are THEMED tokens (bg-bg-card → --surface, teal-50 →
// --accent-soft) — never literal white. This component also renders on
// /onboarding, which sits OUTSIDE the (auth) `.dark-canvas main` scope, so
// the legacy bg-white retint can't reach it there; a literal bg-white would
// read as a white slab with near-white text on the dark theme.
// Both wrap arbitrary children — markdown blocks, tables, images, etc.

import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

interface Props {
  role: 'ai' | 'user';
  /** Optional short eyebrow label (e.g. timestamp, agent name). */
  eyebrow?: string;
  children: ReactNode;
  className?: string;
}

export function MessageBubble({ role, eyebrow, children, className }: Props) {
  const isAi = role === 'ai';
  return (
    <div
      className={cn(
        'flex flex-col gap-1',
        isAi ? 'items-start' : 'items-end',
        className,
      )}
    >
      {eyebrow ? (
        <span className="robo-eyebrow">{eyebrow}</span>
      ) : null}
      <div
        className={cn(
          'w-full rounded-md px-5 py-4 text-[15px] leading-relaxed shadow-card',
          isAi
            ? 'max-w-[720px] border border-ink-line-soft bg-bg-card text-ink-900'
            : 'max-w-[560px] bg-teal-50 text-ink-900',
        )}
      >
        {children}
      </div>
    </div>
  );
}
