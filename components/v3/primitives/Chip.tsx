'use client';

// Chip — an interactive suggestion chip (.chip in the prototype: onboarding
// intent suggestions, filter chips). Clickable; hovering tints it accent. Use
// `selected` for a sticky active state.

import type { ReactNode } from 'react';
import { cn } from '../../../lib/utils';

interface Props {
  children: ReactNode;
  onClick?: () => void;
  selected?: boolean;
  className?: string;
  type?: 'button';
}

export function Chip({ children, onClick, selected = false, className }: Props) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={cn('chip', className)}
      style={
        selected
          ? {
              borderColor: 'var(--accent-text)',
              color: 'var(--accent-text)',
              background: 'var(--accent-soft)',
            }
          : undefined
      }
    >
      {children}
    </button>
  );
}
