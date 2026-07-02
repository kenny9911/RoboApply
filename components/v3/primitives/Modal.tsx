'use client';

// Modal — the V3 dialog. SOLID (opaque) panel background per the CLAUDE.md
// project standard: we use the GLOBAL theme-aware `--surface` token (defined at
// :root + html[data-theme='light'], so it always resolves to an opaque
// #181923 / #FFFFFF), NOT a container-scoped token like `.jb-root`'s
// `--jb-surface` that could resolve to nothing outside its scope. The panel is
// therefore always opaque (backdrop never bleeds through) and stays coherent in
// dark + light. The backdrop keeps a translucent dim tint.
//
// ESC closes; backdrop click closes; clicking inside the panel does not. Locks
// page scroll while open. position:fixed overlay (SSR-safe, no portal hop).
// This mirrors components/ui/Modal.tsx but in the V3 dark palette.

import type { ReactNode } from 'react';
import { useCallback, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '../../../lib/utils';
import { IconX } from './Iconset';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Optional title (rendered as h2). */
  title?: ReactNode;
  /** Optional helper line under the title. */
  description?: ReactNode;
  /** Aria-label for screen readers when there's no title. */
  ariaLabel?: string;
  /** Footer action region (buttons). */
  footer?: ReactNode;
  children: ReactNode;
  maxWidth?: 'sm' | 'md' | 'lg' | 'xl';
  /** Hide the top-right close X (rare). */
  hideClose?: boolean;
  className?: string;
}

const MAX_WIDTH: Record<NonNullable<Props['maxWidth']>, string> = {
  sm: 'max-w-[420px]',
  md: 'max-w-[520px]',
  lg: 'max-w-[640px]',
  xl: 'max-w-[820px]',
};

// Global theme-aware surface token. Per CLAUDE.md the modal panel MUST be fully
// opaque so the backdrop can never bleed through; `--surface` is defined at
// :root + html[data-theme='light'] and always resolves to an opaque color (it
// is NOT a container-scoped token like `--jb-surface`), so it is safe here.
const PANEL_BG = 'var(--surface)';

export function Modal({
  open,
  onClose,
  title,
  description,
  ariaLabel,
  footer,
  children,
  maxWidth = 'md',
  hideClose = false,
  className,
}: Props) {
  const tCommon = useTranslations('common');
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
      aria-label={ariaLabel ?? (typeof title === 'string' ? title : undefined)}
      className="fixed inset-0 z-50 flex items-center justify-center px-4 py-6"
      style={{ background: 'rgba(7, 8, 13, 0.62)', backdropFilter: 'blur(2px)' }}
      onClick={onClose}
    >
      <div
        // Literal solid dark panel — CLAUDE.md modal rule.
        style={{ background: PANEL_BG, border: '1px solid var(--rule)', color: 'var(--text)' }}
        className={cn(
          'relative w-full overflow-hidden rounded-2xl shadow-lift',
          MAX_WIDTH[maxWidth],
          className,
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {!hideClose ? (
          <button
            type="button"
            onClick={onClose}
            aria-label={tCommon('close')}
            className="icon-btn"
            style={{ position: 'absolute', top: 14, right: 14, zIndex: 2 }}
          >
            <IconX size={15} />
          </button>
        ) : null}

        <div className="p-7">
          {title ? (
            <h2
              style={{
                fontFamily: 'var(--sans)',
                fontSize: '20px',
                fontWeight: 600,
                letterSpacing: '-0.02em',
                color: 'var(--text)',
                margin: 0,
                paddingRight: hideClose ? 0 : 36,
              }}
            >
              {title}
            </h2>
          ) : null}
          {description ? (
            <p style={{ marginTop: 8, fontSize: '13.5px', color: 'var(--text-2)' }}>
              {description}
            </p>
          ) : null}
          <div className={cn(title || description ? 'mt-6' : '')}>{children}</div>
        </div>

        {footer ? (
          <div
            className="flex flex-wrap items-center justify-end gap-3 px-7 py-5"
            style={{ borderTop: '1px solid var(--rule)' }}
          >
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}
