'use client';

// OptionPill — the canonical Teal selectable row (§3.1). White bg, soft
// border, optional left-circle (radio), optional right-icon.
// - Unselected: border 1px ink-line, white bg
// - Hover: bg teal-50
// - Selected: border 2px teal-900, circle filled teal with white check

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
        'flex w-full items-center gap-4 rounded-sm bg-white px-5 py-4 text-left transition-colors duration-fast ease-standard',
        selected
          ? 'border-2 border-accent-text'
          : 'border border-ink-line hover:border-ink-300 hover:bg-teal-50',
        interactive && 'cursor-pointer focus-visible:outline-2',
        className,
      )}
    >
      {radio ? (
        <span
          className={cn(
            'flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full border-2',
            selected
              ? 'border-accent-text bg-teal-900'
              : 'border-ink-300 bg-white',
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
                stroke="white"
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
