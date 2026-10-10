'use client';

// components/features/feed/ReportSheet.tsx — "Report a problem" (PRODUCT
// F-FEED-12; ARCHITECTURE.md §4.9).
//
// A report hides the job for the reporter and queues it for review (server).
// GoApply adds 招转培 / 培训贷 / 收费 reasons, which feed the anti-fraud list
// (CN-E-08). After a scam report the sheet offers "Hide agency posts?" — a
// filter change the user confirms (excludeAgencies), never applied silently.

import { useEffect, useId, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Btn, Sheet, toast } from '../../v3/primitives';
import { reportJob } from '../../../lib/api/feed';
import type { FeedItem } from '../../../lib/api/contracts/feed';
import type { ReportReason } from '../../../hooks/shared/useJobActions';
import { useProposalApply } from './useProposalApply';
import styles from './feed.module.css';

const COMMON: readonly ReportReason[] = ['expired', 'scam', 'wrong_info', 'duplicate', 'agency', 'offensive'];
const CN_ONLY: readonly ReportReason[] = ['pay_to_work', 'training_loan', 'fee_required'];

/** Reasons offered on each market, in order. Pure. */
export function reportReasonsFor(market: 'intl' | 'cn'): ReportReason[] {
  return market === 'cn' ? [...COMMON, ...CN_ONLY, 'other'] : [...COMMON, 'other'];
}

export interface ReportSheetProps {
  open: boolean;
  job: Pick<FeedItem, 'jobId' | 'title'>;
  market: 'intl' | 'cn';
  onClose: () => void;
  /** The report was accepted (the job is hidden for this user). */
  onReported: () => void;
}

export function ReportSheet({ open, job, market, onClose, onReported }: ReportSheetProps) {
  const t = useTranslations('jobs.report');
  const formId = useId();
  const proposalApply = useProposalApply();
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<'form' | 'agency'>('form');
  const [sent, setSent] = useState(false);

  useEffect(() => {
    if (!open) return;
    setReason(null);
    setNote('');
    setBusy(false);
    setStep('form');
    setSent(false);
  }, [open]);

  const close = () => {
    onClose();
    if (sent) onReported();
  };

  const submit = async () => {
    if (!reason) return;
    setBusy(true);
    let ok = true;
    try {
      const text = note.trim();
      await reportJob(job.jobId, text ? { reason, note: text } : { reason });
    } catch {
      ok = false;
    }
    setBusy(false);
    if (!ok) {
      toast({ message: t('failed'), tone: 'warn' });
      return;
    }
    setSent(true);
    toast({ message: t('thanks'), tone: 'ok' });
    const agenciesAlreadyHidden = proposalApply.profile?.filters.excludeAgencies === true;
    if (reason === 'scam' && proposalApply.profile && !agenciesAlreadyHidden) {
      setStep('agency');
      return;
    }
    onClose();
    onReported();
  };

  const hideAgencies = async () => {
    const result = await proposalApply.save({ excludeAgencies: true });
    if (result === 'saved') toast({ message: t('agencySaved'), tone: 'ok' });
    close();
  };

  return (
    <Sheet open={open} onClose={close} title={step === 'agency' ? t('agencyOffer') : t('title')}>
      {step === 'agency' ? (
        <div className={styles.form}>
          <p className={styles.help}>{t('agencyOfferBody')}</p>
          <div className={styles.row}>
            <Btn variant="primary" className={styles.actionBtn} onClick={() => void hideAgencies()} disabled={proposalApply.isPending}>
              {t('agencyYes')}
            </Btn>
            <Btn className={styles.actionBtn} onClick={close}>
              {t('agencyNo')}
            </Btn>
          </div>
        </div>
      ) : (
        <form
          className={styles.form}
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <fieldset className={styles.fieldset}>
            <legend className={styles.legend}>{t('reasonsLabel')}</legend>
            {reportReasonsFor(market).map((r) => (
              <label key={r} className={styles.reason}>
                <input type="radio" name={`${formId}-reason`} value={r} checked={reason === r} onChange={() => setReason(r)} />
                {t(`reason.${r}`)}
              </label>
            ))}
          </fieldset>
          <label className={styles.fieldset}>
            <span className={styles.label}>{t('noteLabel')}</span>
            <textarea className={styles.textarea} value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} />
          </label>
          <div className={styles.row}>
            <Btn type="submit" variant="primary" className={styles.actionBtn} disabled={!reason || busy}>
              {busy ? t('working') : t('submit')}
            </Btn>
          </div>
        </form>
      )}
    </Sheet>
  );
}
