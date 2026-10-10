'use client';

// components/v3/account/deleteAccountModal.tsx
//
// The delete-account confirm modal — the REAL deletion flow (accountApi
// deleteAccount → soft-delete now, nightly hard-purge via the GDPR sweep).
// Extracted from app/(auth)/account/page.tsx so the /preferences Danger zone
// can open the identical flow instead of a stub. Owns the whole handshake:
// type-your-email confirm + required reason → forget this device's push
// subscription → mutate → clear this browser → /login.
//
// What this browser forgets (INT-12; components/v3/shell/signOutCleanup.ts):
//   • the push subscription BEFORE the request, while the session can still
//     authorise it. After the account is gone that call would answer 401 and
//     set off the stale-session recovery in lib/api/client.ts;
//   • the unsent resume-builder drafts, the bearer fallback and the TanStack
//     cache (a hard navigation) only AFTER the deletion worked. If it fails
//     the user is still signed in with their drafts; only this device's
//     notifications are off, and Settings → Notifications turns them back on.
//
// An account without an email (GoApply phone or WeChat sign-up; its stored
// address is a generated `…@users.goapply.invalid`, see format.ts
// `isPlaceholderEmail`) is never asked to type that address: it confirms with
// the same fixed word as "Delete job data", the modal sends the stored address
// itself (the server still compares it), and the line about a confirmation
// email is left out because there is no address to send one to.
//
// Copy lives under the `settings.danger.*` namespace in all four locales.

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Btn } from '../primitives/Btn';
import { Modal } from '../primitives/Modal';
import { useDeleteAccount } from '../../../hooks/useAccount';
import { RoboApiError } from '../../../lib/api/client';
import { useAuth } from '../../../lib/auth/AuthProvider';
import { clearDraftsOnSignOut, forgetPushOnSignOut, leaveSignedOut } from '../shell/signOutCleanup';
import { isPlaceholderEmail } from './format';

export function DeleteAccountModal({
  open,
  onClose,
  email,
}: {
  open: boolean;
  onClose: () => void;
  /** The account's email — the user must retype it to confirm (a fixed word instead when the account has no real email). */
  email: string;
}) {
  const t = useTranslations('settings');
  const ta = useTranslations('auth');
  const auth = useAuth();
  const deleteAccount = useDeleteAccount();
  // True from the click until the request fails (on success the page leaves).
  // It covers the push step, which runs before the mutation is pending.
  const [working, setWorking] = useState(false);
  const inFlight = useRef(false);
  const busy = working || deleteAccount.isPending;

  const noRealEmail = isPlaceholderEmail(email);
  const keyword = t('danger.delete_data_confirm_keyword');
  const [confirmEmail, setConfirmEmail] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const onConfirm = async () => {
    if (inFlight.current) return;
    setError(null);
    // `!email` guards the not-yet-resolved-auth window: an unknown account
    // email must never let '' === '' pass the type-to-confirm gate.
    if (noRealEmail) {
      if (confirmEmail.trim().toLowerCase() !== keyword.trim().toLowerCase()) {
        setError(t('danger.delete_data_confirm_error', { keyword }));
        return;
      }
    } else if (!email || confirmEmail.trim().toLowerCase() !== email.trim().toLowerCase()) {
      setError(t('danger.error.mismatch'));
      return;
    }
    if (!reason.trim()) {
      setError(t('danger.error.reasonRequired'));
      return;
    }
    inFlight.current = true;
    setWorking(true);
    // Never throws; gives up by itself after a few seconds.
    await forgetPushOnSignOut();
    deleteAccount.mutate(noRealEmail ? email.trim() : confirmEmail.trim(), {
      onSuccess: () => {
        clearDraftsOnSignOut();
        auth.clear();
        onClose();
        leaveSignedOut();
      },
      onError: (err) => {
        inFlight.current = false;
        setWorking(false);
        const raw = err instanceof RoboApiError ? (err.payload as any)?.code : undefined;
        if (raw === 'confirm_email_mismatch') setError(t('danger.error.mismatch'));
        else setError(t('danger.error.generic'));
      },
    });
  };

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!busy) onClose();
      }}
      title={t('danger.deleteAccount')}
      description={t('danger.deleteDescription')}
      maxWidth="md"
      footer={
        <>
          <Btn variant="ghost" onClick={onClose} disabled={busy}>
            {t('danger.cancel')}
          </Btn>
          <Btn
            className="ra-btn-danger"
            onClick={() => void onConfirm()}
            disabled={busy}
          >
            {t('danger.delete')}
          </Btn>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          <label
            style={{
              fontSize: 'var(--fs-label)',
              color: 'var(--text-muted)',
              fontWeight: 600,
            }}
          >
            {noRealEmail ? t('danger.delete_data_confirm_label') : t('danger.confirmEmailLabel')}
          </label>
          <p style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-2)', margin: 0 }}>
            {noRealEmail ? t('danger.delete_data_confirm_hint', { keyword }) : t('danger.confirmEmailHint', { email })}
          </p>
          <input
            value={confirmEmail}
            onChange={(e) => setConfirmEmail(e.target.value)}
            autoComplete="off"
            className="ra-account-input"
            placeholder={noRealEmail ? keyword : email}
            style={{
              background: 'var(--bg)',
              border: '1px solid var(--rule)',
              borderRadius: 9,
              padding: '10px 12px',
              color: 'var(--text)',
              fontSize: 'var(--fs-meta)',
            }}
          />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          <label
            style={{
              fontSize: 'var(--fs-label)',
              color: 'var(--text-muted)',
              fontWeight: 600,
            }}
          >
            {t('danger.reasonLabel')}
          </label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            className="ra-account-input"
            placeholder={t('danger.reasonPlaceholder')}
            style={{
              background: 'var(--bg)',
              border: '1px solid var(--rule)',
              borderRadius: 9,
              padding: '10px 12px',
              color: 'var(--text)',
              fontFamily: 'var(--font-ui)',
              fontSize: 'var(--fs-meta)',
              resize: 'vertical',
            }}
          />
        </div>

        {/* WP-10 (F-ACCT-06): what happens next — a confirmation email states
            when the deletion is final (30 days; 15 on the mainland site). */}
        {noRealEmail ? null : (
          <p style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-2)', margin: 0 }}>{ta('danger.confirmationEmail')}</p>
        )}

        {error ? (
          <p role="alert" style={{ color: 'var(--danger)', fontSize: 'var(--fs-meta)', margin: 0 }}>
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
