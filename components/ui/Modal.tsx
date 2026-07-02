'use client';

// Modal — solid (opaque) panel with dim backdrop. Per CLAUDE.md PROJECT
// STANDARD the panel bg MUST be fully opaque so the backdrop can never bleed
// through. We use the GLOBAL theme-aware `--surface` token (defined at :root +
// html[data-theme='light'] — always opaque #181923 / #FFFFFF), NOT a
// container-scoped token like `.jb-root`'s `--jb-surface` (the footgun the
// rule warns about, which can resolve to transparent outside its scope). This
// keeps the panel coherent in BOTH themes — hardcoding literal #fff would make
// the dark-mode title text (text-ink-900 = near-white) invisible. The backdrop
// keeps a translucent dim tint.
//
// ESC closes the modal; clicking the backdrop closes; clicking inside the
// panel does NOT close. Renders only when `open`. Uses a portal-free
// position:fixed overlay so it works during SSR without a `<Portal>` hop.

import type { ReactNode } from 'react';
import { useCallback, useEffect } from 'react';
import { cn } from '../../lib/utils';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Optional title rendered as h2 at top of panel. */
  title?: string;
  /** Optional short helper paragraph under the title. */
  description?: string;
  /** Aria-label for screen readers if no title. */
  ariaLabel?: string;
  /** Footer action region (buttons). */
  footer?: ReactNode;
  children: ReactNode;
  maxWidth?: 'sm' | 'md' | 'lg';
  className?: string;
}

const MAX_WIDTH: Record<NonNullable<Props['maxWidth']>, string> = {
  sm: 'max-w-[420px]',
  md: 'max-w-[520px]',
  lg: 'max-w-[640px]',
};

export function Modal({
  open,
  onClose,
  title,
  description,
  ariaLabel,
  footer,
  children,
  maxWidth = 'md',
  className,
}: Props) {
  const handleKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    },
    [onClose],
  );

  useEffect(() => {
    if (!open) return;
    window.addEventListener('keydown', handleKey);
    document.documentElement.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', handleKey);
      document.documentElement.style.overflow = '';
    };
  }, [open, handleKey]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel ?? title}
      className="fixed inset-0 z-50 flex items-center justify-center px-4 py-6"
      style={{ background: 'rgba(15, 30, 28, 0.45)' }}
      onClick={onClose}
    >
      <div
        // Solid, opaque panel — CLAUDE.md modal rule. Global theme-aware
        // `--surface` (always opaque), not a scoped token, so no bleed-through.
        style={{ background: 'var(--surface)' }}
        className={cn(
          'relative w-full rounded-lg shadow-lift',
          MAX_WIDTH[maxWidth],
          className,
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-8">
          {title ? (
            <h2 className="text-xl font-bold tracking-tight text-ink-900">
              {title}
            </h2>
          ) : null}
          {description ? (
            <p className="mt-2 text-sm text-ink-500">{description}</p>
          ) : null}
          <div className={cn(title || description ? 'mt-6' : '')}>{children}</div>
        </div>
        {footer ? (
          <div className="flex flex-wrap items-center justify-end gap-3 border-t border-ink-line-soft px-8 py-5">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}
