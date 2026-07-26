'use client';

// PageHeader — the V3 signature page header (.page-h): an eyebrow pill (with
// optional static dot), the display-face h1, and an optional right-aligned sub
// paragraph. Optional `actions` slot replaces the sub for header buttons.
//
// The headline is ONE continuous string in ONE family (ruling R4). The old
// accentWord/titleAfter props existed only to wrap a word in an italic-serif
// <em> mid-sentence; both are gone. Emphasis now comes from size and weight,
// applied to the whole headline.

import type { ReactNode } from 'react';
import { cn } from '../../../lib/utils';

interface Props {
  /** Eyebrow text, e.g. "Live · 9:14 AM". Omit to hide the eyebrow. */
  eyebrow?: ReactNode;
  /** Show the status dot inside the eyebrow. */
  eyebrowLive?: boolean;
  /** The whole headline, as one string. */
  title: ReactNode;
  /** Right-aligned supporting copy. */
  sub?: ReactNode;
  /** Right-aligned action region (buttons). Rendered instead of `sub` if both. */
  actions?: ReactNode;
  className?: string;
}

export function PageHeader({
  eyebrow,
  eyebrowLive = false,
  title,
  sub,
  actions,
  className,
}: Props) {
  return (
    <header className={cn('page-h', className)}>
      <div>
        {eyebrow ? (
          <span className="eyebrow">
            {eyebrowLive ? <span className="dot" aria-hidden="true" /> : null}
            {eyebrow}
          </span>
        ) : null}
        <h1>{title}</h1>
      </div>
      {actions ? (
        <div className="top-actions">{actions}</div>
      ) : sub ? (
        <p className="sub">{sub}</p>
      ) : null}
    </header>
  );
}
