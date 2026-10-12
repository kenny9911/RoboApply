'use client';

// components/features/feed/NotInterestedSheet.tsx — "Not interested" with a
// reason (PRODUCT F-FEED-11; ARCHITECTURE.md §4.9).
//
// 1. The user picks why. `POST /feed/jobs/:id/hide` hides the job for good
//    (server-persisted) and may propose ONE filter change.
// 2. The proposal is shown field by field (FilterDiff) BEFORE anything is
//    saved: "Save this change" or "Just hide this job". Nothing about the
//    saved search changes without that tap.
//    A proposal whose ops change nothing (unknown paths, values already set)
//    is not shown: the sheet just closes.
// 3. Closing the sheet after a successful hide removes the card.

import { useEffect, useId, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Btn, Sheet, toast } from '../../v3/primitives';
import { FilterDiff } from '../filters';
import type { FeedItem, FilterDiffProposal, HideJobResponse } from '../../../lib/api/contracts/feed';
import type { HideReason } from '../../../hooks/shared/useJobActions';
import { applyPatchPreview, isNoopPatch, opsToPatch } from '../../../hooks/feed/filterOps';
import { useProposalApply } from './useProposalApply';
import styles from './feed.module.css';

/** Reason codes offered, in order (contract HIDE_REASONS). */
export const HIDE_REASON_ORDER: readonly HideReason[] = [
  'wrong_title',
  'wrong_level',
  'wrong_location',
  'pay_too_low',
  'company',
  'already_applied',
  'not_interested',
  'other',
];

export interface NotInterestedSheetProps {
  open: boolean;
  job: Pick<FeedItem, 'jobId' | 'title' | 'company'>;
  market: 'intl' | 'cn';
  onClose: () => void;
  hide: (reason: HideReason, detail?: string) => Promise<HideJobResponse | null>;
  /** The job is hidden on the server: the card may go. */
  onHidden: () => void;
}

export function NotInterestedSheet({ open, job, onClose, hide, onHidden }: NotInterestedSheetProps) {
  const t = useTranslations('jobs.hide');
  const tCard = useTranslations('jobs.card.actions');
  const formId = useId();
  const proposalApply = useProposalApply();
  const [reason, setReason] = useState<HideReason | null>(null);
  const [detail, setDetail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  const [proposal, setProposal] = useState<FilterDiffProposal | null>(null);

  useEffect(() => {
    if (!open) return;
    setReason(null);
    setDetail('');
    setBusy(false);
    setError(null);
    setHidden(false);
    setProposal(null);
  }, [open]);

  const close = () => {
    onClose();
    if (hidden) onHidden();
  };

  const submit = async () => {
    if (!reason) return;
    setBusy(true);
    setError(null);
    const res = await hide(reason, detail.trim() || undefined);
    setBusy(false);
    if (!res) {
      setError(tCard('failed'));
      return;
    }
    setHidden(true);
    const p = res.proposedFilterDiff;
    if (p && Array.isArray(p.ops) && p.ops.length > 0) {
      // Offer the change only when it maps to a real edit of the search.
      const base = proposalApply.target(p.searchProfileId)?.filters ?? {};
      if (!isNoopPatch(base, opsToPatch(base, p.ops))) {
        setProposal(p);
        return;
      }
    }
    onClose();
    onHidden();
  };

  const target = proposal ? proposalApply.target(proposal.searchProfileId) : null;
  const before = target?.filters ?? {};
  const patch = proposal ? opsToPatch(before, proposal.ops) : {};
  const after = applyPatchPreview(before, patch);

  const saveChange = async () => {
    if (!proposal) return;
    const result = await proposalApply.save(patch, proposal.searchProfileId);
    if (result === 'saved') toast({ message: t('changeSaved'), tone: 'ok' });
    else toast({ message: result === 'conflict' ? t('changeConflict') : t('changeFailed'), tone: 'warn' });
    close();
  };

  return (
    <Sheet open={open} onClose={close} title={proposal ? t('proposalTitle') : t('title')} description={proposal ? t('proposalIntro') : t('intro')}>
      {proposal ? (
        <div className={styles.form}>
          <FilterDiff before={before} after={after} filters={after} />
          {proposal.countAfter !== null && Number.isFinite(proposal.countAfter) ? (
            <p className={styles.help}>{t('countAfter', { count: proposal.countAfter })}</p>
          ) : null}
          <div className={styles.row}>
            <Btn variant="primary" className={styles.actionBtn} onClick={() => void saveChange()} disabled={proposalApply.isPending || !target}>
              {t('applyChange')}
            </Btn>
            <Btn className={styles.actionBtn} onClick={close}>
              {t('keepFilters')}
            </Btn>
          </div>
        </div>
      ) : (
        <form
          id={formId}
          className={styles.form}
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <fieldset className={styles.fieldset}>
            <legend className={styles.legend}>{t('reasonsLabel')}</legend>
            {HIDE_REASON_ORDER.map((r) => (
              <label key={r} className={styles.reason}>
                <input type="radio" name={`${formId}-reason`} value={r} checked={reason === r} onChange={() => setReason(r)} />
                {t(`reason.${r}`)}
              </label>
            ))}
          </fieldset>
          <label className={styles.fieldset}>
            <span className={styles.label}>{t('detailLabel')}</span>
            <textarea className={styles.textarea} value={detail} maxLength={500} onChange={(e) => setDetail(e.target.value)} />
          </label>
          {error ? (
            <p className={styles.error} role="alert">
              {error}
            </p>
          ) : null}
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
