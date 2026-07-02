'use client';

// ResumeBuilderMenu — the top-right Menu dropdown on /resumes.
// Placeholder for Help / Sort / Filter — actual sort + filter wiring lives
// in the consuming page state (so the dropdown can toggle the active value).

import { useEffect, useRef, useState } from 'react';
import {
  EllipsisVerticalIcon,
  QuestionMarkCircleIcon,
  ArrowsUpDownIcon,
  FunnelIcon,
} from '@heroicons/react/24/outline';
import { cn } from '../../lib/utils';

export interface ResumeBuilderMenuLabels {
  /** Aria-label for the trigger button, e.g. "Menu" */
  trigger: string;
  help: string;
  sort: string;
  filter: string;
}

interface Props {
  labels: ResumeBuilderMenuLabels;
  onHelp?: () => void;
  onSort?: () => void;
  onFilter?: () => void;
  className?: string;
}

export function ResumeBuilderMenu({
  labels,
  onHelp,
  onSort,
  onFilter,
  className,
}: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleDown(e: MouseEvent | TouchEvent) {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) setOpen(false);
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', handleDown);
    document.addEventListener('touchstart', handleDown);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleDown);
      document.removeEventListener('touchstart', handleDown);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  function pick(cb?: () => void) {
    return () => {
      setOpen(false);
      cb?.();
    };
  }

  return (
    <div ref={ref} className={cn('relative', className)}>
      <button
        type="button"
        aria-label={labels.trigger}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-ink-line-soft bg-bg-card text-ink-700 transition-colors hover:bg-bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-600"
      >
        <EllipsisVerticalIcon className="h-5 w-5" aria-hidden="true" />
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-11 z-20 min-w-[180px] overflow-hidden rounded-md border border-ink-line-soft bg-bg-card shadow-lift"
        >
          <button
            type="button"
            role="menuitem"
            onClick={pick(onHelp)}
            className="flex w-full items-center gap-2 px-3 py-2 text-sm text-ink-700 hover:bg-bg-muted"
          >
            <QuestionMarkCircleIcon
              className="h-4 w-4 text-ink-500"
              aria-hidden="true"
            />
            {labels.help}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={pick(onSort)}
            className="flex w-full items-center gap-2 px-3 py-2 text-sm text-ink-700 hover:bg-bg-muted"
          >
            <ArrowsUpDownIcon
              className="h-4 w-4 text-ink-500"
              aria-hidden="true"
            />
            {labels.sort}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={pick(onFilter)}
            className="flex w-full items-center gap-2 px-3 py-2 text-sm text-ink-700 hover:bg-bg-muted"
          >
            <FunnelIcon
              className="h-4 w-4 text-ink-500"
              aria-hidden="true"
            />
            {labels.filter}
          </button>
        </div>
      ) : null}
    </div>
  );
}
