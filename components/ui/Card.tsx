'use client';

// Card — bg-white panel with --robo-line-soft border and --robo-shadow-card
// shadow. Two padding presets: compact (20×24) and hero (32px).

import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/utils';

interface Props extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  padding?: 'compact' | 'hero' | 'none';
  /** Render a subtle highlight tint (teal-50 bg). */
  tinted?: boolean;
}

const PADDING: Record<NonNullable<Props['padding']>, string> = {
  compact: 'px-6 py-5 md:px-7 md:py-6',
  hero: 'p-8',
  none: '',
};

export function Card({
  children,
  padding = 'compact',
  tinted = false,
  className,
  ...rest
}: Props) {
  return (
    <div
      className={cn(
        'rounded-md border border-ink-line-soft shadow-card',
        tinted ? 'bg-teal-50' : 'bg-white',
        PADDING[padding],
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}
