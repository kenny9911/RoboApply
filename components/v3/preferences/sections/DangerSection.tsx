'use client';

// §08 Danger zone — pause hunt, reset preferences to defaults, delete all
// application data, delete account. The two destructive deletes open a confirm
// Modal (solid panel per the CLAUDE.md rule). Pause toggles huntActive (mirrors
// the rail pause button); Reset restores the server-canonical preferences and
// clears dirty (handled by the parent via `onReset`).

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { PrefHeader } from '../controls';
import { Btn, Modal } from '../../primitives';

type Tone = 'warn' | 'danger';

function DangerRow({
  title,
  desc,
  btn,
  tone,
  finalForm,
  onClick,
}: {
  title: string;
  desc: string;
  btn: string;
  tone: Tone;
  finalForm?: boolean;
  onClick: () => void;
}) {
  return (
    <div className={`pref-danger ${tone}`}>
      <div>
        <div className="pref-danger-title">{title}</div>
        <div className="pref-danger-desc">{desc}</div>
      </div>
      <button
        type="button"
        className={`btn ${tone === 'danger' ? 'pref-btn-danger' : ''}`}
        onClick={onClick}
      >
        {finalForm ? '⚠ ' : ''}
        {btn}
      </button>
    </div>
  );
}

export function DangerSection({
  huntActive,
  onPauseToggle,
  onReset,
}: {
  huntActive: boolean;
  onPauseToggle: () => void;
  onReset: () => void;
}) {
  const t = useTranslations('preferences');
  // Which destructive confirm is open: null | 'data' | 'account'.
  const [confirm, setConfirm] = useState<null | 'data' | 'account'>(null);

  const confirmCopy =
    confirm === 'account'
      ? {
          title: t('danger.delete_account_title'),
          body: t('danger.delete_account_confirm'),
          cta: t('danger.delete_account_btn'),
        }
      : {
          title: t('danger.delete_data_title'),
          body: t('danger.delete_data_confirm'),
          cta: t('danger.delete_data_btn'),
        };

  return (
    <>
      <PrefHeader
        eyebrow={t('danger.eyebrow')}
        title={
          <>
            {t('danger.title_before')} <em>{t('danger.title_em')}</em>
            {t('danger.title_after')}
          </>
        }
        sub={t('danger.sub')}
      />

      <div className="pref-danger-list">
        <DangerRow
          title={t('danger.pause_title')}
          desc={t('danger.pause_desc')}
          btn={huntActive ? t('danger.pause_btn') : t('danger.resume_btn')}
          tone="warn"
          onClick={onPauseToggle}
        />
        <DangerRow
          title={t('danger.reset_title')}
          desc={t('danger.reset_desc')}
          btn={t('danger.reset_btn')}
          tone="warn"
          onClick={onReset}
        />
        <DangerRow
          title={t('danger.delete_data_title')}
          desc={t('danger.delete_data_desc')}
          btn={t('danger.delete_data_btn')}
          tone="danger"
          onClick={() => setConfirm('data')}
        />
        <DangerRow
          title={t('danger.delete_account_title')}
          desc={t('danger.delete_account_desc')}
          btn={t('danger.delete_account_btn')}
          tone="danger"
          finalForm
          onClick={() => setConfirm('account')}
        />
      </div>

      <Modal
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={confirmCopy.title}
        description={confirmCopy.body}
        maxWidth="sm"
        footer={
          <>
            <Btn variant="ghost" onClick={() => setConfirm(null)}>
              {t('danger.cancel')}
            </Btn>
            <Btn variant="primary" onClick={() => setConfirm(null)}>
              {confirmCopy.cta}
            </Btn>
          </>
        }
      >
        <p style={{ fontSize: 13.5, color: 'var(--text-2)', margin: 0 }}>
          {t('danger.confirm_note')}
        </p>
      </Modal>
    </>
  );
}
