'use client';

// §08 Danger zone — pause hunt, reset preferences to defaults, delete all
// application data, delete account. The two destructive deletes each open a
// real confirm modal (solid panel per the CLAUDE.md rule):
//   • "Delete all application data" → WipeDataModal (data-only wipe:
//     accountApi.wipeData → POST /account/wipe-data clears match history /
//     queue / activity / pipeline; account + résumés stay; user stays signed
//     in → success receipt + cache refetch).
//   • "Delete my account" → the shared DeleteAccountModal (type-your-email
//     confirm → accountApi.deleteAccount soft-delete + nightly hard-purge →
//     sign-out → /login) — the same modal /account uses.
// Pause toggles huntActive (mirrors the rail pause button); Reset restores the
// server-canonical preferences and clears dirty (handled by the parent via
// `onReset`).

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { PrefHeader } from '../controls';
import { WipeDataModal } from '../WipeDataModal';
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
  const [wipeOpen, setWipeOpen] = useState(false);
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
          title={t('danger.delete_data_title')}
          desc={t('danger.delete_data_desc')}
          btn={t('danger.delete_data_btn')}
          tone="danger"
          onClick={() => setWipeOpen(true)}
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

      <WipeDataModal open={wipeOpen} onClose={() => setWipeOpen(false)} />

      <DeleteAccountModal
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        email={accountEmail}
      />
    </>
  );
}
