'use client';

// BuilderSection — the collapsible "Contact Information / Target Title / …"
// row used inside the left-pane editor. The Teal reference shows a chevron,
// section title, and an optional right-side action (e.g. "+" to add an entry).

import { ChevronDownIcon } from '@heroicons/react/24/outline';
import { useState, type ReactNode } from 'react';
import { cn } from '../../../lib/utils';

interface Props {
  id?: string;
  title: string;
  /** Optional small text under the title — e.g. "3 entries". */
  subtitle?: string;
  defaultOpen?: boolean;
  /** Right-side row of buttons (e.g. + Add). */
  actions?: ReactNode;
  children: ReactNode;
}

export function BuilderSection({
  id,
  title,
  subtitle,
  defaultOpen = false,
  actions,
  children,
}: Props) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section
      id={id}
      className="overflow-hidden rounded-md border border-ink-line-soft bg-white"
    >
      <header className="flex items-center justify-between gap-3 border-b border-ink-line-soft px-4 py-3">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="group flex flex-1 items-center gap-2 text-left"
        >
          <ChevronDownIcon
            className={cn(
              'h-4 w-4 text-ink-500 transition-transform',
              open ? 'rotate-0' : '-rotate-90',
            )}
            aria-hidden="true"
          />
          <span className="text-sm font-semibold text-ink-900">{title}</span>
          {subtitle ? (
            <span className="text-xs text-ink-500">{subtitle}</span>
          ) : null}
        </button>
        {actions ? <div className="flex items-center gap-1">{actions}</div> : null}
      </header>
      {open ? <div className="px-4 py-4">{children}</div> : null}
    </section>
  );
}
