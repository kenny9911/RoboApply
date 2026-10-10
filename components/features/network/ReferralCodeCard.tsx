'use client';

// ReferralCodeCard — one moderated 内推码 (GoApply hub, WP-54). Shows the
// company, the code, the programme and the use-by date as the sharer gave
// them, and "Shared by a %BRAND% user, {month year}". Nothing here claims a
// code works or leads to an interview. Copy and Report are the only actions
// on someone else's code; the sharer can delete their own.

import { useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import { Btn, Modal, toast } from '../../v3/primitives';
import { useDeleteReferralCode, useReportReferralCode, referralErrorKind } from '../../../hooks/network';
import type { ReferralCodeView, ReferralReportReason } from '../../../lib/api/contracts/cn/referrals';
import { PhoneRequiredNotice } from './PhoneRequiredNotice';
import styles from './network.module.css';

const REASONS: readonly ReferralReportReason[] = ['expired', 'invalid', 'spam', 'paid', 'other'];

export function ReferralCodeCard({ item, showStatus = false }: { item: ReferralCodeView; showStatus?: boolean }) {
  const t = useTranslations('people.referrals');
  const format = useFormatter();
  const report = useReportReferralCode();
  const remove = useDeleteReferralCode();
  const [reporting, setReporting] = useState(false);
  const [reason, setReason] = useState<ReferralReportReason>('expired');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [phoneRequired, setPhoneRequired] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(item.code);
      toast({ message: t('copied'), tone: 'ok' });
    } catch {
      /* clipboard blocked: the code stays selectable */
    }
  };

  const sendReport = async () => {
    setError(null);
    setPhoneRequired(false);
    try {
      await report.mutateAsync({ id: item.id, reason, note: note.trim() || undefined });
      setReporting(false);
      toast({ message: t('reported'), tone: 'ok' });
    } catch (err) {
      const kind = referralErrorKind(err);
      // A WeChat-only account must bind a mobile number before reporting (real-name rule).
      if (kind === 'phone_binding_required') setPhoneRequired(true);
      else setError(t(`error.${kind}`));
    }
  };

  const del = async () => {
    try {
      await remove.mutateAsync(item.id);
      toast({ message: t('deleted'), tone: 'ok' });
    } catch (err) {
      toast({ message: t(`error.${referralErrorKind(err)}`), tone: 'danger' });
    }
  };

  return (
    <li className={styles.card} data-referral={item.id} data-status={item.status}>
      <div className={styles.spread}>
        <p className={styles.name}>{item.company}</p>
        {showStatus ? <span className={styles.status}>{t(`status.${item.status}`)}</span> : null}
      </div>
      <div className={styles.row}>
        <span className={styles.code} data-testid="referral-code">
          {item.code}
        </span>
        <Btn variant="ghost" onClick={copy}>
          {t('copyCode')}
        </Btn>
      </div>
      {item.programme ? <p className={styles.body}>{item.programme}</p> : null}
      <p className={styles.muted}>{item.expiresAt ? t('expires', { date: format.dateTime(new Date(`${item.expiresAt}T00:00:00Z`), { dateStyle: 'medium', timeZone: 'UTC' }) }) : t('noExpiry')}</p>
      {item.note ? <p className={styles.muted}>{item.note}</p> : null}
      <p className={styles.muted} data-testid="referral-shared">
        {t('shared', { date: format.dateTime(new Date(item.sharedAt), { year: 'numeric', month: 'long' }) })}
      </p>
      {item.mine && item.status === 'rejected' && item.rejectReason ? <p className={styles.muted}>{t(`rejectReason.${item.rejectReason}`)}</p> : null}
      <div className={styles.row}>
        {item.mine ? (
          <Btn variant="ghost" onClick={del} disabled={remove.isPending}>
            {t('delete')}
          </Btn>
        ) : item.reportedByMe ? (
          <p className={styles.muted}>{t('reportedAlready')}</p>
        ) : (
          <Btn variant="ghost" onClick={() => setReporting(true)}>
            {t('report')}
          </Btn>
        )}
      </div>
      <Modal
        open={reporting}
        onClose={() => setReporting(false)}
        title={t('reportTitle')}
        footer={
          <Btn variant="primary" onClick={sendReport} disabled={report.isPending}>
            {t('reportSubmit')}
          </Btn>
        }
      >
        <div className={styles.form}>
          <fieldset className={styles.radios}>
            <legend className={styles.muted}>{t('reportReason')}</legend>
            {REASONS.map((r) => (
              <label key={r} className={styles.radio}>
                <input type="radio" name={`reason-${item.id}`} value={r} checked={reason === r} onChange={() => setReason(r)} />
                {t(`reason.${r}`)}
              </label>
            ))}
          </fieldset>
          <label className={styles.field}>
            {t('reportNote')}
            <textarea className={styles.textarea} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
          </label>
          {phoneRequired ? <PhoneRequiredNotice /> : null}
          {error ? (
            <p className={styles.error} role="alert">
              {error}
            </p>
          ) : null}
        </div>
      </Modal>
    </li>
  );
}

export default ReferralCodeCard;
