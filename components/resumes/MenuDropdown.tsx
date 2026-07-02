'use client';

// MenuDropdown — anchored popover next to the header "Menu" button used in
// the resume builder. Outside-click + Escape close it. Items can be regular
// or `danger` (red). Submenu items show a right chevron and are wired up by
// the caller (we don't manage nested menus here — the caller can open a
// modal instead).

import {
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
  type SVGProps,
} from 'react';
import { ChevronRightIcon, EllipsisHorizontalIcon } from '@heroicons/react/24/outline';
import { cn } from '../../lib/utils';

export interface MenuItem {
  id: string;
  label: string;
  Icon?: ComponentType<SVGProps<SVGSVGElement>>;
  /** Renders the item in red. */
  danger?: boolean;
  /** Renders a chevron on the right and skips closing the menu on click. */
  hasSubmenu?: boolean;
  /** Pass-through click handler; the menu auto-closes unless `hasSubmenu`. */
  onClick?: () => void;
  /** Render a horizontal divider above this item. */
  divider?: boolean;
}

interface Props {
  items: MenuItem[];
  /** Label text on the trigger button. Defaults to "Menu". */
  triggerLabel?: string;
  /** Optional custom trigger node. If supplied, replaces the default button. */
  trigger?: ReactNode;
  /** Optional aria-label for the trigger (when label text is empty). */
  triggerAriaLabel?: string;
  /** Visual style of the default trigger. */
  triggerVariant?: 'outline' | 'ghost';
  className?: string;
}

export function MenuDropdown({
  items,
  triggerLabel = 'Menu',
  trigger,
  triggerAriaLabel,
  triggerVariant = 'outline',
  className,
}: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function handleItemClick(item: MenuItem) {
    item.onClick?.();
    if (!item.hasSubmenu) setOpen(false);
  }

  return (
    <div ref={rootRef} className={cn('relative inline-flex', className)}>
      {trigger ? (
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={triggerAriaLabel}
          onClick={() => setOpen((v) => !v)}
          className="inline-flex"
        >
          {trigger}
        </button>
      ) : (
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={triggerAriaLabel ?? triggerLabel}
          onClick={() => setOpen((v) => !v)}
          className={cn(
            'inline-flex h-9 items-center gap-2 rounded-md px-3 text-sm font-semibold transition-colors',
            triggerVariant === 'outline'
              ? 'border border-ink-line bg-white text-ink-900 hover:bg-bg-muted'
              : 'text-ink-700 hover:bg-bg-muted',
          )}
        >
          <EllipsisHorizontalIcon className="h-4 w-4" aria-hidden="true" />
          <span>{triggerLabel}</span>
        </button>
      )}
      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-full z-50 mt-1 w-64 overflow-hidden rounded-md border border-ink-line bg-white py-1 shadow-lift"
        >
          {items.map((item) => (
            <div key={item.id}>
              {item.divider ? (
                <div className="my-1 h-px bg-ink-line-soft" aria-hidden="true" />
              ) : null}
              <button
                type="button"
                role="menuitem"
                onClick={() => handleItemClick(item)}
                className={cn(
                  'flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors',
                  item.danger
                    ? 'text-danger hover:bg-danger/5'
                    : 'text-ink-900 hover:bg-bg-muted',
                )}
              >
                {item.Icon ? (
                  <item.Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                ) : (
                  <span className="h-4 w-4 shrink-0" aria-hidden="true" />
                )}
                <span className="flex-1">{item.label}</span>
                {item.hasSubmenu ? (
                  <ChevronRightIcon
                    className="h-4 w-4 text-ink-500"
                    aria-hidden="true"
                  />
                ) : null}
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
