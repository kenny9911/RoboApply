'use client';

// components/v3/account/deleteAccountModal.tsx
//
// The delete-account confirm modal — the REAL deletion flow (accountApi
// deleteAccount → soft-delete now, nightly hard-purge via the GDPR sweep).
// Extracted from app/(auth)/account/page.tsx so the /preferences Danger zone
// can open the identical flow instead of a stub. Owns the whole handshake:
// type-your-email confirm + required reason → mutate → sign out → /login.
//
// Copy lives under the `account.danger.*` namespace in all four locales.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { Btn } from '../primitives/Btn';
import { Modal } from '../primitives/Modal';
import { useDeleteAccount } from '../../../hooks/useAccount';
import { RoboApiError } from '../../../lib/api/client';
import { useAuth } from '../../../lib/auth/AuthProvider';

export function DeleteAccountModal({
  open,
  onClose,
  email,
}: {
  open: boolean;
  onClose: () => void;
  /** The account's email — the user must retype it to confirm. */
  email: string;
}) {
  const t = useTranslations('account');
  const router = useRouter();
  const auth = useAuth();
  const deleteAccount = useDeleteAccount();

  const [confirmEmail, setConfirmEmail] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const onConfirm = () => {
    setError(null);
    // `!email` guards the not-yet-resolved-auth window: an unknown account
    // email must never let '' === '' pass the type-to-confirm gate.
    if (!email || confirmEmail.trim().toLowerCase() !== email.trim().toLowerCase()) {
      setError(t('danger.error.mismatch'));
      return;
    }
    if (!reason.trim()) {
      setError(t('danger.error.reasonRequired'));
      return;
    }
    deleteAccount.mutate(confirmEmail.trim(), {
      onSuccess: () => {
        auth.clear();
        onClose();
        router.replace('/login');
      },
      onError: (err) => {
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
        if (!deleteAccount.isPending) onClose();
      }}
      title={t('danger.deleteAccount')}
      description={t('danger.deleteDescription')}
      maxWidth="md"
      footer={
        <>
          <Btn variant="ghost" onClick={onClose} disabled={deleteAccount.isPending}>
            {t('danger.cancel')}
          </Btn>
          <Btn
            className="ra-btn-danger"
            onClick={onConfirm}
            disabled={deleteAccount.isPending}
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
              fontFamily: 'var(--mono)',
              fontSize: '11px',
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              color: 'var(--muted)',
              fontWeight: 600,
            }}
          >
            {t('danger.confirmEmailLabel')}
          </label>
          <p style={{ fontSize: '12.5px', color: 'var(--text-2)', margin: 0 }}>
            {t('danger.confirmEmailHint', { email })}
          </p>
          <input
            value={confirmEmail}
            onChange={(e) => setConfirmEmail(e.target.value)}
            autoComplete="off"
            className="ra-account-input"
            placeholder={email}
            style={{
              background: 'var(--bg)',
              border: '1px solid var(--rule)',
              borderRadius: 9,
              padding: '10px 12px',
              color: 'var(--text)',
              fontFamily: 'var(--mono)',
              fontSize: '13px',
            }}
          />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          <label
            style={{
              fontFamily: 'var(--mono)',
              fontSize: '11px',
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              color: 'var(--muted)',
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
              fontFamily: 'var(--sans)',
              fontSize: '13px',
              resize: 'vertical',
            }}
          />
        </div>

        {error ? (
          <p role="alert" style={{ color: 'var(--danger)', fontSize: '12.5px', margin: 0 }}>
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
