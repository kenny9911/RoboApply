'use client';

// components/v3/preferences/WipeDataModal.tsx
//
// The "Delete all application data" confirm modal for /preferences §08 Danger
// Zone. Data-ONLY wipe — clears match history / queue / activity / pipeline via
// accountApi.wipeData (POST /account/wipe-data); the account, profile, and
// résumés survive and the user stays signed in. Contrast with the shared
// DeleteAccountModal (components/v3/account/deleteAccountModal.tsx), which
// soft-deletes the whole account and signs out.
//
// Because it's less catastrophic than account deletion (nothing here is
// unrecoverable-by-identity), the gate is lighter than that modal's type-your-
// email + reason: the user types a short localized confirm keyword. On success
// we swap to an in-modal receipt (per-table counts) and a Done button rather
// than a toast — the app has no toast surface, and useWipeData already
// invalidated the V2/V3 caches so the emptied pages repaint behind the modal.
//
// Copy lives under the `preferences.danger.delete_data_*` namespace (all four
// locales), alongside the row it opens.

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Btn } from '../primitives/Btn';
import { Modal } from '../primitives/Modal';
import { useWipeData } from '../../../hooks/useAccount';
import type { WipeDataResponse } from '../../../lib/api/account';

const LABEL_STYLE: React.CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: '11px',
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  color: 'var(--muted)',
  fontWeight: 600,
};

export function WipeDataModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const t = useTranslations('preferences');
  const wipe = useWipeData();

  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<WipeDataResponse | null>(null);

  // Fresh start each time the modal opens — never show a prior run's receipt or
  // a stale typed keyword when the user reopens the dialog.
  useEffect(() => {
    if (open) {
      setConfirm('');
      setError(null);
      setDone(null);
      wipe.reset();
    }
    // wipe.reset is stable; intentionally keyed on `open` only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const keyword = t('danger.delete_data_confirm_keyword');

  const onConfirm = () => {
    setError(null);
    if (confirm.trim().toLowerCase() !== keyword.trim().toLowerCase()) {
      setError(t('danger.delete_data_confirm_error', { keyword }));
      return;
    }
    wipe.mutate(undefined, {
      onSuccess: (summary) => setDone(summary),
      onError: () => setError(t('danger.delete_data_error')),
    });
  };

  const totalCleared = done
    ? done.trackerEntries + done.matchScores + done.runs + done.digests
    : 0;

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!wipe.isPending) onClose();
      }}
      title={t('danger.delete_data_title')}
      description={done ? undefined : t('danger.delete_data_confirm')}
      maxWidth="sm"
      footer={
        done ? (
          <Btn variant="primary" onClick={onClose}>
            {t('danger.delete_data_done')}
          </Btn>
        ) : (
          <>
            <Btn variant="ghost" onClick={onClose} disabled={wipe.isPending}>
              {t('danger.delete_data_cancel')}
            </Btn>
            <Btn
              className="ra-btn-danger"
              onClick={onConfirm}
              disabled={wipe.isPending}
            >
              {t('danger.delete_data_confirm_cta')}
            </Btn>
          </>
        )
      }
    >
      {done ? (
        <p role="status" style={{ fontSize: 13.5, color: 'var(--text-2)', margin: 0, lineHeight: 1.5 }}>
          {t('danger.delete_data_success', { count: totalCleared })}
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          <label style={LABEL_STYLE}>{t('danger.delete_data_confirm_label')}</label>
          <p style={{ fontSize: '12.5px', color: 'var(--text-2)', margin: 0 }}>
            {t('danger.delete_data_confirm_hint', { keyword })}
          </p>
          <input
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="off"
            className="ra-account-input"
            placeholder={keyword}
            disabled={wipe.isPending}
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
          {error ? (
            <p role="alert" style={{ color: 'var(--danger)', fontSize: '12.5px', margin: 0 }}>
              {error}
            </p>
          ) : null}
        </div>
      )}
    </Modal>
  );
}
