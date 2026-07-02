'use client';

// StatStrip + Stat — the 4-up hero metric row (.stat-strip / .stat). One Stat
// per cell: a mono uppercase key, a big value, and an optional mono delta. The
// first cell is usually `hero` (accent-filled). The strip is a responsive grid
// (4 → 2 → 2 cols) from styles/v3.css.

import type { ReactNode } from 'react';
import { cn } from '../../../lib/utils';

export function StatStrip({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn('stat-strip', className)}>{children}</div>;
}

interface StatProps {
  /** Mono uppercase caption. */
  label: ReactNode;
  /** The big number / value. */
  value: ReactNode;
  /** Optional mono delta (e.g. "+3 today"). */
  delta?: ReactNode;
  /** Accent-filled hero variant (first cell). */
  hero?: boolean;
  className?: string;
}

export function Stat({ label, value, delta, hero = false, className }: StatProps) {
  return (
    <div className={cn('stat', hero && 'hero', className)}>
      <div className="k">{label}</div>
      <div className="v robo-tnum">
        {value}
        {delta ? <span className="delta">{delta}</span> : null}
      </div>
    </div>
  );
}
