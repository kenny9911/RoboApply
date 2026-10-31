'use client';

// components/v3/admin/ViewAsButton.tsx — "View as" one person (the god's-eye
// view; server platform/viewAs). Starts a read-only view and reloads into the
// page the person lands on after signing in (their onboarding screen while it
// is unfinished), so nothing cached from the admin's own session is shown as
// theirs. The button is off, with the reason beside it, for the accounts the
// server refuses: the admin's own, an admin account, an account that never
// used the app, a deleted one, and one of the other brand (viewed from that
// brand's admin console). A refusal the list could not foresee is shown the
// same way.

import { useId } from 'react';
import { useTranslations } from 'next-intl';
import { useStartViewAs } from '../../../hooks/useViewAs';
import { useAuth } from '../../../lib/auth/useAuth';
import { useBrand } from '../../../lib/brand/BrandProvider';
import { RoboApiError } from '../../../lib/api/client';
import type { ViewAsBlockedReason } from '../../../lib/api/admin';
import { Btn } from '../primitives/Btn';
import { IconPerson } from '../primitives/Iconset';
import styles from './console.module.css';

export interface ViewAsTarget {
  userId: string;
  name?: string | null;
  email?: string;
  /** Signed-up brand; null/absent for accounts read before brands existed (viewable anywhere). */
  brand?: string | null;
  isAdmin?: boolean;
  /** False when the account never used the app (no profile). Absent = not known here. */
  hasProfile?: boolean;
  deleted?: boolean;
}

const REASONS: readonly ViewAsBlockedReason[] = ['self', 'admin_account', 'not_seeker', 'deleted', 'other_brand', 'needs_session'];

/** Why this list row cannot be viewed, as far as the row tells (the server decides). */
export function viewAsBlockedReasonFor(target: ViewAsTarget, me: { id: string } | null, brandId: string): ViewAsBlockedReason | null {
  if (me && target.userId === me.id) return 'self';
  if (target.isAdmin) return 'admin_account';
  if (target.hasProfile === false) return 'not_seeker';
  if (target.deleted) return 'deleted';
  if (target.brand && target.brand !== brandId) return 'other_brand';
  return null;
}

/** The refusal reason the server gave (`details.reason`), when it is one we can explain. */
export function viewAsRefusalReason(error: unknown): ViewAsBlockedReason | null {
  if (!(error instanceof RoboApiError)) return null;
  const details = (error.payload as { details?: { reason?: unknown } } | undefined)?.details;
  const reason = details?.reason;
  return typeof reason === 'string' && (REASONS as readonly string[]).includes(reason) ? (reason as ViewAsBlockedReason) : null;
}

export function ViewAsButton({
  target,
  variant = 'inline',
  navigate = (url) => window.location.assign(url),
}: {
  target: ViewAsTarget;
  variant?: 'inline' | 'button';
  /** A full page load into the person's landing page (a test seam). */
  navigate?: (url: string) => void;
}) {
  const t = useTranslations('adminOps.viewAs');
  const { user } = useAuth();
  const brand = useBrand();
  const start = useStartViewAs();
  const noteId = useId();
  const who = target.name || target.email || target.userId;
  const blocked = viewAsBlockedReasonFor(target, user, brand.id);
  const refused = start.isError ? viewAsRefusalReason(start.error) : null;
  const reason = blocked ?? refused;
  const note = reason ? t(`blocked.${reason}`) : start.isError ? t('failed') : null;
  const pending = start.isPending || start.isSuccess;
  const label = pending ? t('opening') : variant === 'button' ? t('button', { name: who }) : t('action');
  const onClick = () => start.mutate(target.userId, { onSuccess: (view) => navigate(view.landing) });

  if (variant === 'button') {
    return (
      <span className={styles.viewAs}>
        <Btn icon={<IconPerson size={15} />} disabled={!!blocked || pending} aria-describedby={note ? noteId : undefined} title={t('hint')} onClick={onClick}>
          {label}
        </Btn>
        {note ? <small id={noteId} role={start.isError ? 'alert' : undefined}>{note}</small> : null}
      </span>
    );
  }
  return (
    <span className={styles.viewAsInline}>
      <button type="button" disabled={!!blocked || pending} aria-label={t('aria', { name: who })} aria-describedby={note ? noteId : undefined} title={note ?? t('hint')} onClick={onClick}>
        {label}
      </button>
      {note && start.isError ? <small id={noteId} role="alert">{note}</small> : note ? <span id={noteId} className="sr-only">{note}</span> : null}
    </span>
  );
}
