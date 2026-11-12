'use client';

// prepare_application — "Prepare your application for {job}"
// (docs/agent-driven/REDESIGN.md §1, §5, §9).
//
// The Assistant's form of the one-tap "Prepare application": the cost is on
// the card BEFORE anything is spent, in the cost sheet's own lines (CostLine:
// "Uses 1 kit; you have 2 left this week", the weekly allowance first, then
// tailoring and a letter when they apply), from the server's credit proposal.
// The button spends through the `ready_kits` credit gate (one idempotency key
// per press; with none left the out-of-credits sheet opens and nothing is
// sent; a 402 for another bucket opens it with the server's bucket). Applying
// puts the job on the list when it is not there, then starts the preparation;
// the server answers with where the application stands, which this card then
// shows with its link.
//
// D1: preparing tailors the resume and writes a letter when the post asks for
// one. Nothing is sent to any company; the user opens the application and
// submits it themselves.

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';

import { invalidateReady } from '../../../../hooks/agent';
import { isExpired, useProposal } from '../../../../hooks/copilot';
import { useFlag } from '../../../../lib/flags';
import { Btn, HonestyLine } from '../../../v3/primitives';
import { CostLine, noTailorKey } from '../../agent';
import { ApplicationStatusBody } from './ApplicationStatusCard';
import { CardFrame } from './CardFrame';
import { applicationResult, initialProposalStatus, jobLine, parsePrepareApplication } from './model';
import type { CardProps } from './types';
import styles from '../copilot.module.css';

export function PrepareApplicationCard({ card, ctx }: CardProps) {
  const t = useTranslations('assistant.cards');
  const ready = useTranslations('ready');
  const qc = useQueryClient();
  const aiText = useFlag('ai.text');
  const data = parsePrepareApplication(card.data);
  const proposal = useProposal(data?.proposalId ?? card.id, {
    // The weekly allowance is what every preparation uses.
    bucket: 'ready_kits',
    initial: data ? initialProposalStatus(data.status, isExpired(data.expiresAt)) : 'pending',
  });
  // What the server said went wrong (its `details.reason`), for the line under the card.
  const [problem, setProblem] = useState<string | null>(null);
  if (!data) return null;

  const job = jobLine(data.jobTitle, data.company) ?? t('credit.jobFallback');
  const { status } = proposal;
  const result = status === 'applied' ? applicationResult(proposal.result) : null;
  const cost = (bucket: 'ready_kits' | 'tailor' | 'cover_letter') => data.credits.find((c) => c.bucket === bucket)?.cost ?? 0;

  const confirm = async () => {
    setProblem(null);
    const out = await proposal.apply();
    if (out.kind === 'applied') void invalidateReady(qc);
    // Used by an earlier click: what it left is in the thread, not in this answer.
    else if (out.kind === 'closed' && out.status === 'applied') ctx.refresh?.();
    else if (out.kind === 'failed') {
      setProblem(out.code);
      // The post closed: the server closed the suggestion too.
      if (out.code === 'job_closed') proposal.setStatus('conflict');
    }
  };

  const problemLine =
    problem === 'queue_full' ? ready('oneTap.full') : problem === 'feature_disabled' ? t('applicationStatus.unavailable') : ready('oneTap.failed');

  return (
    <CardFrame card={card} title={t('prepare.title', { job })}>
      {status === 'pending' || status === 'applying' || status === 'failed' ? (
        <>
          {data.addsToList ? <p className={styles.cardText}>{t('prepare.addsToList')}</p> : null}
          <div className={styles.costLines} data-testid="prepare-cost">
            <CostLine bucket="ready_kits" cost={cost('ready_kits')} />
            {cost('tailor') > 0 ? (
              <CostLine bucket="tailor" cost={cost('tailor')} />
            ) : (
              <p>{ready(noTailorKey({ aiAvailable: data.aiAvailable }, aiText, data.tailorEach ?? undefined))}</p>
            )}
            {cost('cover_letter') > 0 ? <CostLine bucket="cover_letter" cost={cost('cover_letter')} /> : null}
          </div>
          <p className={styles.cardText}>{ready('prepare.whatHappens')}</p>
          <HonestyLine kind="you_submit" />
          {status === 'failed' ? (
            <p className={styles.alert} role="alert" data-testid="proposal-problem">
              {problemLine}
            </p>
          ) : null}
          {status === 'applying' ? (
            <p className={styles.cardText} role="status" data-testid="proposal-applying">
              {t('applying')}
            </p>
          ) : ctx.turn === 'streaming' ? (
            <p className={styles.cardText} data-testid="proposal-waiting">
              {t('waitForAnswer')}
            </p>
          ) : proposal.inProgress ? (
            <p className={styles.cardText} role="status" data-testid="proposal-in-progress">
              {t('inProgress')}
            </p>
          ) : null}
          <div className={styles.cardActions}>
            <Btn variant="primary" disabled={status === 'applying' || ctx.turn === 'streaming'} aria-busy={status === 'applying' || undefined} onClick={() => void confirm()}>
              {ready('oneTap.action')}
            </Btn>
            <Btn variant="ghost" disabled={status === 'applying'} onClick={() => void proposal.dismiss()}>
              {t('notNow')}
            </Btn>
          </div>
        </>
      ) : null}
      {status === 'applied' ? (
        <>
          <p className={styles.cardText} role="status">
            {t('credit.done')}
          </p>
          {result ? <ApplicationStatusBody data={result} ctx={ctx} /> : null}
        </>
      ) : null}
      {status === 'dismissed' ? <p className={styles.cardText}>{t('credit.dismissed')}</p> : null}
      {status === 'expired' ? <p className={styles.cardText}>{t('proposalExpired')}</p> : null}
      {status === 'conflict' ? (
        <p className={styles.cardText} data-testid="proposal-closed">
          {problem === 'job_closed' ? ready('oneTap.closed') : t('proposalClosed')}
        </p>
      ) : null}
    </CardFrame>
  );
}
