'use client';

// Settings § Danger zone — delete all job data, delete the account. Each
// opens a real confirm modal (solid panel per the CLAUDE.md rule):
//   • "Delete your job data" → WipeDataModal (accountApi.wipeData →
//     POST /account/wipe-data clears match history / queue / activity /
//     pipeline; the account and resumes stay; the user stays signed in →
//     success receipt + cache refetch).
//   • "Delete your account" → the shared DeleteAccountModal (type-your-email
//     confirm → accountApi.deleteAccount soft-delete + nightly hard-purge →
//     sign-out → /login).
//
// Gone:
//   • "Reset your settings" (INT-12). It said "Clears everything on this
//     page" but only dropped unsaved edits — exactly what Discard on the save
//     bar does — and did nothing at all when there were none. A button that
//     does not do what it says is a dead end.
//   • "Pause hunt": it toggled the switch of the background auto-apply
//     engine, and auto-apply is deleted (rulings R1).

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { PrefHeader } from '../controls';
import { WipeDataModal } from '../WipeDataModal';
import { DeleteAccountModal } from '../../account';

type Tone = 'danger';

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

export function DangerSection({ accountEmail }: { accountEmail: string }) {
  const t = useTranslations('settings');
  const [wipeOpen, setWipeOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  return (
    <>
      <PrefHeader
        eyebrow={t('danger.eyebrow')}
        title={`${t('danger.title_before')} ${t('danger.title_em')}${t('danger.title_after')}`}
        sub={t('danger.sub')}
      />

      <div className="pref-danger-list">
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
