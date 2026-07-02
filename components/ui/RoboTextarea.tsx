'use client';

// RoboTextarea — for the intent + tone steering free-text fields.
// 16px body, padding 16×20, radius from --robo-radius-sm.
// Same label pattern as RoboInput (label above, hint/error below).

import type { TextareaHTMLAttributes } from 'react';
import { forwardRef } from 'react';
import { cn } from '../../lib/utils';

interface Props extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  hint?: string;
  error?: string;
  containerClassName?: string;
}

export const RoboTextarea = forwardRef<HTMLTextAreaElement, Props>(
  function RoboTextarea(
    { label, hint, error, className, containerClassName, id, rows = 4, ...rest },
    ref,
  ) {
    const inputId =
      id ?? `robo-ta-${Math.random().toString(36).slice(2, 9)}`;
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
        <textarea
          id={inputId}
          ref={ref}
          rows={rows}
          className={cn(
            'w-full resize-y rounded-sm border bg-white px-5 py-4 text-base font-medium text-ink-900 placeholder:font-normal placeholder:text-ink-300 transition-colors focus:outline-none',
            error
              ? 'border-danger focus:shadow-focus'
              : 'border-ink-line focus:border-accent-text focus:shadow-focus',
            className,
          )}
          {...rest}
        />
        {error ? (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        ) : hint ? (
          <p className="text-sm italic text-ink-500">{hint}</p>
        ) : null}
      </div>
    );
  },
);
