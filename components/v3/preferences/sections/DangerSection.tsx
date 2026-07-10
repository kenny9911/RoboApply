'use client';

// §08 Danger zone — pause hunt, reset preferences to defaults, delete account.
// "Delete my account" opens the shared DeleteAccountModal (the real flow:
// type-your-email confirm → accountApi.deleteAccount soft-delete + nightly
// hard-purge → sign-out → /login) — the same modal /account uses.
// A "delete all application data" row (data-only wipe, account stays) is
// deliberately absent: no server endpoint exists yet, and destructive buttons
// don't ship as stubs. Pause toggles huntActive (mirrors the rail pause
// button); Reset restores the server-canonical preferences and clears dirty
// (handled by the parent via `onReset`).

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { PrefHeader } from '../controls';
import { DeleteAccountModal } from '../../account';

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
  accountEmail,
}: {
  huntActive: boolean;
  onPauseToggle: () => void;
  onReset: () => void;
  accountEmail: string;
}) {
  const t = useTranslations('preferences');
  const [deleteOpen, setDeleteOpen] = useState(false);

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
          title={t('danger.delete_account_title')}
          desc={t('danger.delete_account_desc')}
          btn={t('danger.delete_account_btn')}
          tone="danger"
          finalForm
          onClick={() => setDeleteOpen(true)}
        />
      </div>

      <DeleteAccountModal
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        email={accountEmail}
      />
    </>
  );
}
