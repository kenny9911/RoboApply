'use client';

// PageHeader — the V3 signature page header (.page-h): a mono eyebrow pill
// (with optional live dot), a big Space-Grotesk h1 where one word is rendered
// in Instrument-Serif italic accent, and an optional right-aligned sub
// paragraph. Optional `actions` slot replaces the sub for header buttons.
//
// Two ways to set the accent word:
//   • <PageHeader title="Good morning," accentWord="Marcus" titleAfter="." />
//     → "Good morning, *Marcus*."
//   • pass `title` as a ReactNode that includes its own <em> for full control.

import type { ReactNode } from 'react';
import { cn } from '../../../lib/utils';

interface Props {
  /** Mono eyebrow text, e.g. "LIVE · 9:14 AM". Omit to hide the eyebrow. */
  eyebrow?: ReactNode;
  /** Show the blinking accent dot inside the eyebrow. */
  eyebrowLive?: boolean;
  /** Headline. Either a plain leading string (use with accentWord) or a node. */
  title: ReactNode;
  /** The Instrument-Serif italic accent word (rendered after `title`). */
  accentWord?: ReactNode;
  /** Trailing plain text after the accent word (e.g. a period). */
  titleAfter?: ReactNode;
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
  accentWord,
  titleAfter,
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
        <h1>
          {title}
          {accentWord ? <em>{accentWord}</em> : null}
          {titleAfter}
        </h1>
      </div>
      {actions ? (
        <div className="top-actions">{actions}</div>
      ) : sub ? (
        <p className="sub">{sub}</p>
      ) : null}
    </header>
  );
}
