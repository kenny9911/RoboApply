'use client';

// Overlay — the shared core of Drawer and Sheet (FND-6a). Not exported from
// the primitives index; use <Drawer> or <Sheet>.
//
// Focus management (ARCHITECTURE.md §10.2 rule 8 — "focus management in
// drawers"):
//   • on open, focus moves into the panel (the first focusable element, else
//     the panel itself);
//   • Tab and Shift+Tab stay inside the panel;
//   • Escape and a scrim click call onClose;
//   • on close, focus returns to the element that had it before.
// Rendered through a portal on <body> so no ancestor transform or overflow can
// trap the fixed panel. Page scroll is locked while open.

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslations } from 'next-intl';

import { cn } from '../../../lib/utils';
import { IconX } from './Iconset';
import styles from './primitives.module.css';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface OverlayBaseProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  description?: ReactNode;
  /** Accessible name when there is no string title. */
  ariaLabel?: string;
  footer?: ReactNode;
  children: ReactNode;
  /** Hide the close button (Escape and the scrim still close). */
  hideClose?: boolean;
  className?: string;
  /** Element to focus first instead of the first focusable one. */
  initialFocusRef?: React.RefObject<HTMLElement | null>;
}

export function Overlay({
  open,
  onClose,
  title,
  description,
  ariaLabel,
  footer,
  children,
  hideClose = false,
  className,
  initialFocusRef,
  panelClassName,
  grabber = false,
  testId,
}: OverlayBaseProps & { panelClassName: string; grabber?: boolean; testId?: string }) {
  const tCommon = useTranslations('common');
  const panelRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descId = useId();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !panelRef.current) return;
      const items = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) {
        e.preventDefault();
        panelRef.current.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === panelRef.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    },
    [onClose],
  );

  // Focus in on open; give focus back on close.
  useEffect(() => {
    if (!open || !mounted) return undefined;
    returnFocusRef.current = (document.activeElement as HTMLElement | null) ?? null;
    const panel = panelRef.current;
    const target =
      initialFocusRef?.current ?? panel?.querySelector<HTMLElement>(FOCUSABLE) ?? panel;
    target?.focus();
    const prevOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    return () => {
      document.documentElement.style.overflow = prevOverflow;
      const back = returnFocusRef.current;
      if (back && typeof back.focus === 'function' && document.contains(back)) back.focus();
    };
  }, [open, mounted, initialFocusRef]);

  if (!open || !mounted) return null;

  const named = title != null && title !== false;
  return createPortal(
    <>
      <div className={styles.scrim} aria-hidden="true" onClick={onClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={named && !ariaLabel ? titleId : undefined}
        aria-label={ariaLabel}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={cn(styles.panel, panelClassName, className)}
        onKeyDown={onKeyDown}
        data-testid={testId}
      >
        {grabber ? <div className={styles.grabber} aria-hidden="true" /> : null}
        {title || !hideClose ? (
          <div className={styles.head}>
            <div>
              {title ? (
                <h2 id={titleId} className={styles.title}>
                  {title}
                </h2>
              ) : null}
              {description ? (
                <p id={descId} className={styles.description}>
                  {description}
                </p>
              ) : null}
            </div>
            {!hideClose ? (
              <button type="button" className={styles.close} onClick={onClose} aria-label={tCommon('close')}>
                <IconX size={16} />
              </button>
            ) : null}
          </div>
        ) : null}
        <div className={styles.body}>{children}</div>
        {footer ? <div className={styles.foot}>{footer}</div> : null}
      </div>
    </>,
    document.body,
  );
}
