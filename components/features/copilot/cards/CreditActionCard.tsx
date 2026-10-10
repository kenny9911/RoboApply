'use client';

// credit_action — an AI action that spends credits (tailor, cover letter,
// outreach draft, job import, resume rewrite), proposed by the Assistant
// (F-ORION-12, F-RES-11).
//
// The cost line is shown BEFORE anything runs ("Uses 1 of your 2 left
// today", from the server's credit summary); the credits are spent only when
// the user presses the confirm button (useProposal + useCreditGate: one
// idempotency key per press, the out-of-credits sheet on 402). Nothing is
// sent to anyone (D1): drafts come back for the user to copy.

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { isExpired, useProposal } from '../../../../hooks/copilot';
import { bucketSummary, useCredits } from '../../../../hooks/shared/useCredits';
import { Btn, CreditNotice } from '../../../v3/primitives';
import { AiGeneratedBadge } from '../../market';
import { CardFrame } from './CardFrame';
import { parseCoverLetter, parseCreditAction, parseJobImported, parseRewriteReady, parseTailorReady, type CreditActionKind } from './model';
import type { CardProps } from './types';
import styles from '../copilot.module.css';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

/** What an applied proposal produced, as something the card can render. Pure. */
export function creditResult(
  action: CreditActionKind,
  result: unknown,
): { href: string; label: 'tailor' | 'letter' | 'job' | 'jobFinish' | 'rewrite' } | { draft: string } | null {
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
  const text = isObj(data) ? (typeof data.text === 'string' ? data.text : typeof data.draft === 'string' ? data.draft : null) : null;
  return text && text.trim() ? { draft: text.trim() } : null;
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
    initial: data?.status === 'applied' ? 'applied' : data?.status === 'dismissed' ? 'dismissed' : data && (data.status === 'expired' || isExpired(data.expiresAt)) ? 'expired' : 'pending',
  });
  const [copied, setCopied] = useState(false);
  if (!data) return null;

  const job = data.jobTitle ? (data.company ? `${data.jobTitle} · ${data.company}` : data.jobTitle) : t('credit.jobFallback');
  const title = data.action === 'job_import' ? t('credit.job_import.title') : t(`credit.${data.action}.title`, { job });
  const { status } = proposal;
  const out = status === 'applied' ? creditResult(data.action, proposal.result) : null;

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
          <div className={styles.cardActions}>
            <Btn variant="primary" disabled={status === 'applying'} onClick={() => void proposal.apply()}>
              {t(`credit.${data.action}.confirm`)}
            </Btn>
            <Btn variant="ghost" disabled={status === 'applying'} onClick={() => void proposal.dismiss()}>
              {t('notNow')}
            </Btn>
          </div>
        </>
      ) : null}
      {status === 'expired' ? <p className={styles.cardText}>{t('proposalExpired')}</p> : null}
      {status === 'dismissed' ? <p className={styles.cardText}>{t('credit.dismissed')}</p> : null}
      {status === 'applied' ? (
        <>
          <p className={styles.cardText} role="status">
            {t('credit.done')}
          </p>
          {out && 'href' in out ? (
            <Link href={out.href} className={styles.link} onClick={ctx.onNavigate}>
              {RESULT_LINK[out.label](t)}
            </Link>
          ) : null}
          {out && 'draft' in out ? (
            <>
              <AiGeneratedBadge />
              <p className={styles.fact}>{out.draft}</p>
              <p className={styles.cardText}>{t('credit.youSend')}</p>
              <div className={styles.cardActions}>
                <Btn onClick={() => void copy(out.draft)}>{copied ? t('credit.copied') : t('credit.copy')}</Btn>
              </div>
            </>
          ) : null}
        </>
      ) : null}
    </CardFrame>
  );
}
