'use client';

// RoboInput — the large 56px input field from the Teal-UI spec §3.5.
// 18px text, weight 600, generous padding. The answer feels permanent the
// moment the user types it.
//
// Mirrors HTMLInputElement props. Accepts a leading `label` for the
// always-visible label pattern (Teal style — labels are above the field,
// not inside as a placeholder).

import type { InputHTMLAttributes, ReactNode } from 'react';
import { forwardRef } from 'react';
import { cn } from '../../lib/utils';

interface Props extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
  error?: string;
  rightSlot?: ReactNode;
  containerClassName?: string;
}

export const RoboInput = forwardRef<HTMLInputElement, Props>(
  function RoboInput(
    { label, hint, error, rightSlot, className, containerClassName, id, ...rest },
    ref,
  ) {
    const inputId =
      id ?? `robo-input-${Math.random().toString(36).slice(2, 9)}`;
    return (
      <div className={cn('flex w-full flex-col gap-2', containerClassName)}>
        {label ? (
          <label
            htmlFor={inputId}
            className="text-sm font-semibold text-ink-900"
          >
            {label}
          </label>
        ) : null}
        <div
          className={cn(
            'flex h-14 w-full items-center rounded-sm border bg-white px-5 transition-colors',
            error
              ? 'border-danger focus-within:shadow-focus'
              : 'border-ink-line focus-within:border-accent-text focus-within:shadow-focus',
          )}
        >
          <input
            id={inputId}
            ref={ref}
            className={cn(
              'h-full flex-1 bg-transparent text-[18px] font-semibold text-ink-900 placeholder:font-normal placeholder:text-ink-300 focus:outline-none',
              className,
            )}
            {...rest}
          />
          {rightSlot}
        </div>
        {error ? (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        ) : hint ? (
          <p className="text-sm text-ink-500">{hint}</p>
        ) : null}
      </div>
    );
  },
);
