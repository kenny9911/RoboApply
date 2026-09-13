'use client';

// RoboButton — legacy native control using the shared action and surface
// palette. Children must be translated strings.

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
    'inline-flex select-none items-center justify-center gap-2 rounded-sm font-semibold transition-colors duration-fast ease-standard disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-action';

  const variants: Record<NonNullable<Props['variant']>, string> = {
    primary:
      'bg-action text-action-ink shadow-cta hover:bg-action-hover disabled:bg-ink-line disabled:text-ink-300 disabled:shadow-none',
    outline:
      'border-2 border-action bg-surface text-action hover:bg-action-subtle disabled:border-ink-line disabled:text-ink-300 disabled:bg-surface',
    ghost:
      'bg-transparent text-action hover:bg-action-subtle disabled:text-ink-300',
    danger:
      'border border-danger bg-surface text-danger hover:bg-danger/5 disabled:border-ink-line disabled:text-ink-300',
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
