'use client';

// OptionPill — the canonical selectable row (§3.1). Surface bg, soft
// border, optional left-circle (radio), optional right-icon.
// - Unselected: border 1px ink-line, card-surface bg
// - Hover: bg accent-50
// - Selected: border 2px accent, circle filled accent with accent-ink check
//
// Uses THEME TOKENS (bg-bg-card / accent-*), never literal bg-white: this
// row renders on /onboarding, which sits OUTSIDE the .dark-canvas retint
// wrapper, so a literal `bg-white` would paint white-on-white in dark mode
// (see memory overlay-routes-escape-dark-retint). Tokens flip correctly in
// both light and dark.

import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

interface Props {
  label: string;
  description?: string;
  selected?: boolean;
  onClick?: () => void;
  rightIcon?: ReactNode;
  /** When set, renders a left-side filled/empty circle (radio). */
  radio?: boolean;
  /** Style as a button (i.e. not a focusable input). */
  as?: 'button' | 'div';
  className?: string;
}

export function OptionPill({
  label,
  description,
  selected = false,
  onClick,
  rightIcon,
  radio = true,
  as = 'button',
  className,
}: Props) {
  const Tag = as === 'button' ? 'button' : 'div';
  const interactive = as === 'button';

  return (
    <Tag
      {...(interactive
        ? { type: 'button' as const, onClick, 'aria-pressed': selected }
        : {})}
      className={cn(
        'flex w-full items-center gap-4 rounded-sm bg-bg-card px-5 py-4 text-left transition-colors duration-fast ease-standard',
        selected
          ? 'border-2 border-accent-text'
          : 'border border-ink-line hover:border-ink-300 hover:bg-accent-50',
        interactive && 'cursor-pointer focus-visible:outline-2',
        className,
      )}
    >
      {radio ? (
        <span
          className={cn(
            'flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full border-2',
            selected
              ? 'border-accent-text bg-accent-500'
              : 'border-ink-300 bg-bg-card',
          )}
        >
          {selected ? (
            <svg
              width="10"
              height="10"
              viewBox="0 0 10 10"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M1.5 5.2 3.7 7.5 8.5 2.5"
                stroke="var(--accent-ink)"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          ) : null}
        </span>
      ) : null}
      <span className="flex-1">
        <span className="block text-base font-semibold text-ink-900">
          {label}
        </span>
        {description ? (
          <span className="mt-1 block text-sm text-ink-500">{description}</span>
        ) : null}
      </span>
      {rightIcon ? (
        <span className="ml-2 text-ink-700">{rightIcon}</span>
      ) : null}
    </Tag>
  );
}
