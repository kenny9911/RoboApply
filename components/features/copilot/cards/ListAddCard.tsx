'use client';

// list_add — "Put {job} on your list" (docs/agent-driven/REDESIGN.md §9).
//
// The job joins the user's list (Applications → Getting ready) only when the
// user presses the button: no credit is used, and nothing is prepared or sent.
// The server answers with where the application stands (an
// application_status result), which this card then shows with its link.
// Failures say what happened: the list is full, the post closed (the
// suggestion closes with it), the account cannot prepare applications, or a
// plain "try again". A second click on a suggestion an earlier click already
// used shows the closed line and reads the thread's cards again (the result
// that click left), like the other suggestion cards.

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';

import { invalidateReady } from '../../../../hooks/agent';
import { isExpired, useProposal } from '../../../../hooks/copilot';
import { Btn } from '../../../v3/primitives';
import { ApplicationStatusBody } from './ApplicationStatusCard';
import { CardFrame } from './CardFrame';
import { applicationResult, initialProposalStatus, jobLine, parseListAdd } from './model';
import type { CardProps } from './types';
import styles from '../copilot.module.css';

export function ListAddCard({ card, ctx }: CardProps) {
  const t = useTranslations('assistant.cards');
  const ready = useTranslations('ready');
  const qc = useQueryClient();
  const data = parseListAdd(card.data);
  const proposal = useProposal(data?.proposalId ?? card.id, {
    initial: data ? initialProposalStatus(data.status, isExpired(data.expiresAt)) : 'pending',
  });
  // What the server said went wrong (its `details.reason`), for the line under the card.
  const [problem, setProblem] = useState<string | null>(null);
  if (!data) return null;

  const job = jobLine(data.jobTitle, data.company) ?? t('credit.jobFallback');
  const { status } = proposal;
  const result = status === 'applied' ? applicationResult(proposal.result) : null;

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
    problem === 'queue_full' ? ready('oneTap.full') : problem === 'feature_disabled' ? t('applicationStatus.unavailable') : t('failed');

  return (
    <CardFrame card={card} title={t('listAdd.title', { job })}>
      {status === 'pending' || status === 'applying' || status === 'failed' ? (
        <>
          <p className={styles.cardText}>{t('listAdd.body')}</p>
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
              {t('listAdd.confirm')}
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
          {problem === 'job_closed' ? t('applicationStatus.closed') : t('proposalClosed')}
        </p>
      ) : null}
    </CardFrame>
  );
}
