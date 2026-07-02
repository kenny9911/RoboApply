'use client';

// RoboButton — the canonical CTA. Single brand color (teal-900). NO amber.
// Two real variants per the Teal-UI spec (03-teal-ui-reference.md §8):
//   - primary (solid teal-900, white text)        — commit-level actions
//   - outline (white bg, teal-900 border + ink)    — "next" / progress-forward
//
// Plus a quiet `ghost` for in-context affordances (back links, dismiss).
//
// 14–16px text, weight 600, padding 14×28, radius from --robo-radius-sm.
// Per CLAUDE.md i18n rule — children must be translated strings.

import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/utils';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'outline' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  fullWidth?: boolean;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
}

const SIZING: Record<NonNullable<Props['size']>, string> = {
  sm: 'h-9 px-4 text-[13px]',
  md: 'h-12 px-6 text-sm',
  lg: 'h-14 px-7 text-base',
};

export function RoboButton({
  variant = 'primary',
  size = 'md',
  loading = false,
  fullWidth = false,
  leftIcon,
  rightIcon,
  className,
  children,
  disabled,
  ...rest
}: Props) {
  const base =
    'inline-flex select-none items-center justify-center gap-2 rounded-sm font-semibold transition-colors duration-fast ease-standard disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700';

  const variants: Record<NonNullable<Props['variant']>, string> = {
    primary:
      'bg-teal-900 text-accent-ink shadow-cta hover:bg-teal-700 disabled:bg-ink-line disabled:text-ink-300 disabled:shadow-none',
    outline:
      'border-2 border-accent-text bg-white text-accent-text hover:bg-teal-50 disabled:border-ink-line disabled:text-ink-300 disabled:bg-white',
    ghost:
      'bg-transparent text-accent-text hover:bg-teal-50 disabled:text-ink-300',
    danger:
      'border border-danger bg-white text-danger hover:bg-danger/5 disabled:border-ink-line disabled:text-ink-300',
  };

  return (
    <button
      type="button"
      className={cn(
        base,
        SIZING[size],
        variants[variant],
        fullWidth && 'w-full',
        className,
      )}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? (
        <svg
          className="h-4 w-4 animate-spin"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <circle
            cx="12"
            cy="12"
            r="9"
            fill="none"
            stroke="currentColor"
            strokeOpacity="0.25"
            strokeWidth="3"
          />
          <path
            d="M21 12a9 9 0 0 0-9-9"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
          />
        </svg>
      ) : (
        leftIcon
      )}
      <span>{children}</span>
      {!loading ? rightIcon : null}
    </button>
  );
}
