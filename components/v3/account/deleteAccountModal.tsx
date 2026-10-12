'use client';

// components/v3/account/deleteAccountModal.tsx
//
// The delete-account confirm modal — the REAL deletion flow (accountApi
// deleteAccount → soft-delete now, nightly hard-purge via the GDPR sweep).
// Extracted from app/(auth)/account/page.tsx so the /preferences Danger zone
// can open the identical flow instead of a stub. Owns the whole handshake:
// type-your-email confirm → forget this device's push
// subscription → mutate → clear this browser → /login.
//
// No "Reason" field. It used to be required without saying so, and what the
// user typed was never sent anywhere (POST /account/delete takes only the
// confirmation). A box that collects an answer and drops it is removed, not
// made optional; it can return when the API stores the reason.
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
// the same fixed word as "Delete job data" (`accountV2.prefs.danger.confirmKeyword`,
// a word in the user's own language: a Chinese user is not asked to type
// "DELETE"), the modal sends the stored address
// itself (the server still compares it), and the line about a confirmation
// email is left out because there is no address to send one to. The same line
// is left out when this brand sends no email at all (`notify.email` off, e.g.
// GoApply today): the modal then only says what is true, that every device is
// signed out right away.
//
// Copy lives under the `settings.danger.*` namespace in all four locales.

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Btn } from '../primitives/Btn';
import { Modal } from '../primitives/Modal';
import { useDeleteAccount } from '../../../hooks/useAccount';
import { RoboApiError } from '../../../lib/api/client';
import { useAuth } from '../../../lib/auth/AuthProvider';
import { useFlag } from '../../../lib/flags';
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
  const tp = useTranslations('accountV2.prefs.danger');
  const auth = useAuth();
  // A confirmation email is promised only when one can be sent (fails closed while the flags load).
  const emailOn = useFlag('notify.email');
  const deleteAccount = useDeleteAccount();
  // True from the click until the request fails (on success the page leaves).
  // It covers the push step, which runs before the mutation is pending.
  const [working, setWorking] = useState(false);
  const inFlight = useRef(false);
  const busy = working || deleteAccount.isPending;

  const noRealEmail = isPlaceholderEmail(email);
  // One word for both danger dialogs, in the user's language (删除 on GoApply), compared without case.
  const keyword = tp('confirmKeyword');
  const [confirmEmail, setConfirmEmail] = useState('');
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
            htmlFor="ra-delete-confirm"
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
            id="ra-delete-confirm"
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

        {/* WP-10 (F-ACCT-06): what happens next. The confirmation email (it
            states when the deletion is final: 30 days; 15 on the mainland
            site) is promised only when there is an address and email is on. */}
        <p style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-2)', margin: 0 }}>
          {!noRealEmail && emailOn ? ta('danger.confirmationEmail') : tp('signedOutNow')}
        </p>

        {error ? (
          <p role="alert" style={{ color: 'var(--danger)', fontSize: 'var(--fs-meta)', margin: 0 }}>
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
