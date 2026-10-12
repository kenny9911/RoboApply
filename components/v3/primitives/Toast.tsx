'use client';

// Toast — short, user-prompted confirmations ("Saved", "Moved to Applied ·
// Undo") (FND-6a; PRODUCT_PLAN.md F-NOTIF-06).
//
//   import { toast } from '…/primitives';
//   toast({ message: t('saved') });
//   toast({ message: t('moved'), action: { label: t('undo'), onClick: undo } });
//
// <Toaster /> is mounted once by the app shell. Rules:
//   • a toast answers something the user just did — it is not a nudge, an
//     offer or an announcement (those go through lib/ui/popupGate.ts);
//   • no countdown banners: a toast disappears after its duration, it never
//     shows a timer;
//   • announced politely to screen readers (role="status"); `danger` uses
//     role="alert".

import { useEffect, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';

import { createStore } from '../../../hooks/shared/store';
import { cn } from '../../../lib/utils';
import styles from './primitives.module.css';

export type ToastTone = 'info' | 'ok' | 'warn' | 'danger';

export interface ToastInput {
  message: string;
  tone?: ToastTone;
  action?: { label: string; onClick: () => void };
  /** Milliseconds on screen; 0 keeps it until dismissed. Default 5000 (8000 with an action). */
  durationMs?: number;
}

export interface ToastItem extends Required<Pick<ToastInput, 'message' | 'tone'>> {
  id: number;
  action?: ToastInput['action'];
  durationMs: number;
}

/** At most this many on screen; the oldest goes first. */
export const MAX_TOASTS = 3;

const store = createStore<ToastItem[]>([]);
let seq = 0;

export function toast(input: ToastInput): number {
  seq += 1;
  const id = seq;
  const item: ToastItem = {
    id,
    message: input.message,
    tone: input.tone ?? 'info',
    action: input.action,
    durationMs: input.durationMs ?? (input.action ? 8000 : 5000),
  };
  store.set((prev) => [...prev, item].slice(-MAX_TOASTS));
  return id;
}

export function dismissToast(id: number): void {
  store.set((prev) => (prev.some((t) => t.id === id) ? prev.filter((t) => t.id !== id) : prev));
}

/** Tests only. */
export const __toastStore = store;

export function useToasts(): ToastItem[] {
  return useSyncExternalStore(store.subscribe, store.get, () => EMPTY);
}
const EMPTY: ToastItem[] = [];

function ToastView({ item }: { item: ToastItem }) {
  useEffect(() => {
    if (item.durationMs <= 0) return undefined;
    const id = window.setTimeout(() => dismissToast(item.id), item.durationMs);
    return () => window.clearTimeout(id);
  }, [item.id, item.durationMs]);

  const toneClass =
    item.tone === 'ok' ? styles.toastOk : item.tone === 'warn' ? styles.toastWarn : item.tone === 'danger' ? styles.toastDanger : undefined;
  return (
    <div className={cn(styles.toast, toneClass)} role={item.tone === 'danger' ? 'alert' : 'status'}>
      <p className={styles.toastMessage}>{item.message}</p>
      {item.action ? (
        <button
          type="button"
          className={styles.toastAction}
          onClick={() => {
            item.action?.onClick();
            dismissToast(item.id);
          }}
        >
          {item.action.label}
        </button>
      ) : null}
    </div>
  );
}

/** Mount once (the app shell does). */
export function Toaster() {
  const items = useToasts();
  if (typeof document === 'undefined' || items.length === 0) return null;
  return createPortal(
    <div className={styles.toaster} aria-live="polite">
      {items.map((item) => (
        <ToastView key={item.id} item={item} />
      ))}
    </div>,
    document.body,
  );
}
