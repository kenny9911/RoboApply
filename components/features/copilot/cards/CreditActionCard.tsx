'use client';

// credit_action — an AI action that spends credits (tailor, cover letter,
// outreach draft, job import, resume rewrite), proposed by the Assistant
// (F-ORION-12, F-RES-11).
//
// The cost line is shown BEFORE anything runs ("Uses 1 of your 2 left
// today", from the server's credit summary); the credits are spent only when
// the user presses the confirm button (useProposal + useCreditGate: one
// idempotency key per press, the out-of-credits sheet on 402). Nothing is
// sent to anyone (D1): an outreach draft comes back as text for the user to
// copy and send themselves, with a link to the job's People tab where the
// draft is kept. On reload the card shows the server's `data.status`.
//
// A second click: "Done." is said only for a click this card saw finish. When
// the server answers that the suggestion is closed, the card never claims a
// result it does not hold:
//   • an earlier click is still being worked on (`applying`): the card stays
//     open and says so; the work may still fail, and then the button works
//     again. It does not tell the user to ask again (that would be a second
//     paid action);
//   • it was already applied (an earlier click whose answer was lost, or
//     another tab): the closed line, and the thread's stored cards are read
//     again (`ctx.refresh`), so the result that click left — the card with
//     the link — shows up under this one.

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { isExpired, useProposal } from '../../../../hooks/copilot';
import { bucketSummary, useCredits } from '../../../../hooks/shared/useCredits';
import { Btn, CreditNotice } from '../../../v3/primitives';
import { AiGeneratedBadge } from '../../market';
import { CardFrame } from './CardFrame';
import {
  initialProposalStatus,
  parseCoverLetter,
  parseCreditAction,
  parseJobImported,
  parseOutreachDraft,
  parseRewriteReady,
  parseTailorReady,
  type CreditActionKind,
} from './model';
import type { CardProps } from './types';
import styles from '../copilot.module.css';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

/** What an applied proposal produced, as something the card can render. Pure. */
export function creditResult(
  action: CreditActionKind,
  result: unknown,
): { href: string; label: 'tailor' | 'letter' | 'job' | 'jobFinish' | 'rewrite' } | { draft: string; subject: string | null; peopleHref: string | null } | null {
  const data = isObj(result) && isObj(result.card) ? result.card.data : result;
  if (action === 'tailor') {
    const link = parseTailorReady(data);
    return link ? { href: link.href, label: 'tailor' } : null;
  }
  if (action === 'cover_letter') {
    const link = parseCoverLetter(data);
    return link ? { href: link.href, label: 'letter' } : null;
  }
  if (action === 'job_import') {
    const job = parseJobImported(data);
    return job ? { href: job.href, label: job.jobId ? 'job' : 'jobFinish' } : null;
  }
  if (action === 'rewrite') {
    const rewrite = parseRewriteReady(data);
    return rewrite ? { href: rewrite.href, label: 'rewrite' } : null;
  }
  // outreach: `{ card: People-tab link, draft: { text, subject, jobId } }` (server proposals.ts).
  const draft = parseOutreachDraft(result);
  return draft ? { draft: draft.text, subject: draft.subject, peopleHref: draft.href } : null;
}

/** The link text of each result kind. */
const RESULT_LINK: Record<'tailor' | 'letter' | 'job' | 'jobFinish' | 'rewrite', (t: (key: string) => string) => string> = {
  tailor: (t) => t('tailorReady.open'),
  letter: (t) => t('coverLetter.open'),
  job: (t) => t('jobImported.open'),
  jobFinish: (t) => t('jobImported.finish'),
  rewrite: (t) => t('rewriteReady.open'),
};

export function CreditActionCard({ card, ctx }: CardProps) {
  const t = useTranslations('assistant.cards');
  const data = parseCreditAction(card.data);
  const credits = useCredits();
  const proposal = useProposal(data?.proposalId ?? card.id, {
    bucket: data?.bucket ?? null,
    initial: data ? initialProposalStatus(data.status, isExpired(data.expiresAt)) : 'pending',
  });
  const [copied, setCopied] = useState(false);
  if (!data) return null;

  const job = data.jobTitle ? (data.company ? `${data.jobTitle} · ${data.company}` : data.jobTitle) : t('credit.jobFallback');
  const title = data.action === 'job_import' ? t('credit.job_import.title') : t(`credit.${data.action}.title`, { job });
  const { status } = proposal;
  const out = status === 'applied' ? creditResult(data.action, proposal.result) : null;

  const confirm = async () => {
    const outcome = await proposal.apply();
    // Applied by an earlier click: what it made is in the thread, not in this answer.
    if (outcome.kind === 'closed' && outcome.status === 'applied') ctx.refresh?.();
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <CardFrame card={card} title={title}>
      {status === 'pending' || status === 'applying' || status === 'failed' ? (
        <>
          <p className={styles.cardText}>{t('credit.cost', { cost: data.cost })}</p>
          {data.cost > 0 ? <CreditNotice bucket={bucketSummary(credits.data?.summary, data.bucket)} cost={data.cost} /> : null}
          {data.action === 'outreach' ? <p className={styles.cardText}>{t('credit.youSend')}</p> : null}
          {status === 'failed' ? (
            <p className={styles.alert} role="alert">
              {t('failed')}
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
              {t(`credit.${data.action}.confirm`)}
            </Btn>
            <Btn variant="ghost" disabled={status === 'applying'} onClick={() => void proposal.dismiss()}>
              {t('notNow')}
            </Btn>
          </div>
        </>
      ) : null}
      {status === 'expired' ? <p className={styles.cardText}>{t('proposalExpired')}</p> : null}
      {status === 'conflict' ? <p className={styles.cardText}>{t('proposalClosed')}</p> : null}
      {status === 'dismissed' ? <p className={styles.cardText}>{t('credit.dismissed')}</p> : null}
      {status === 'applied' ? (
        <>
          <p className={styles.cardText} role="status">
            {t('credit.done')}
          </p>
          {out && 'label' in out ? (
            <Link href={out.href} className={styles.link} onClick={ctx.onNavigate}>
              {RESULT_LINK[out.label](t)}
            </Link>
          ) : null}
          {out && 'draft' in out ? (
            <div data-testid="outreach-draft">
              <AiGeneratedBadge />
              {out.subject ? <p className={styles.subTitle}>{out.subject}</p> : null}
              <p className={styles.fact} style={{ whiteSpace: 'pre-wrap' }}>
                {out.draft}
              </p>
              <p className={styles.cardText}>{t('credit.youSend')}</p>
              <div className={styles.cardActions}>
                <Btn onClick={() => void copy(out.subject ? `${out.subject}\n\n${out.draft}` : out.draft)}>{copied ? t('credit.copied') : t('credit.copy')}</Btn>
                {out.peopleHref ? (
                  <Link href={out.peopleHref} className={styles.link} onClick={ctx.onNavigate}>
                    {t('credit.outreach.open')}
                  </Link>
                ) : null}
              </div>
            </div>
          ) : null}
          {data.action === 'outreach' && !out ? (
            // After a reload the draft text is not in the chat; it is kept on the job's People tab.
            <p className={styles.cardText}>{t('credit.outreach.kept')}</p>
          ) : null}
        </>
      ) : null}
    </CardFrame>
  );
}
