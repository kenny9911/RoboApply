'use client';

// KitReview — /ready/[jobId]: one job's application kit (PRODUCT F-AGENT-05,
// 06, 10, 11).
//
//   header       job, company, fit, the kit's real state; "You submit each
//                application yourself."
//   not ready    picked / failed → "Prepare kit" (cost first; a failed kit
//                says why in plain words); preparing → updates by itself;
//                expired → "No longer listed" + Remove; skipped → "You
//                skipped this job" + Put back (no kit parts: none was used)
//   main column  tailored resume (Verify details) · cover letter · answers
//   side column  open application (+ Undo) · files · practice · history
//   footer       Skip this job · Remove from list
//
// The job is found in the user's list by its job id; a job not on the list
// offers "Add to Ready to apply".

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { Btn, EmptyState, FitTierLabel, HonestyLine, PageHeader, Pill, toast } from '../../v3/primitives';
import { useJob, useAddToReady } from '../../../hooks/job';
import { useProfile } from '../../../hooks/profile/useProfile';
import {
  canPrepare,
  failedReasonOf,
  isUnavailable,
  jobSummaryOf,
  lastErrorOf,
  useAgentSettings,
  useKitActions,
  useKitAiAvailable,
  useKitDetail,
  useReadyQueue,
  type PrepareRunResult,
  type ReadyQueueItem,
} from '../../../hooks/agent';
import { useCapabilities, useFlag } from '../../../lib/flags';
import { KitAnswersPart, KitFilesPart, KitHistoryPart, KitLetterPart, KitOpenPart, KitPracticePart, KitResumePart, kitErrorKey } from './KitParts';
import { PrepareSheet } from './PrepareSheet';
import { ReadyUnavailable } from './ReadyPage';
import { STATE_TONE } from './states';
import styles from './ready.module.css';

export interface KitReviewProps {
  jobId: string;
}

export function KitReview({ jobId }: KitReviewProps) {
  const t = useTranslations('ready');
  const { status } = useCapabilities();
  const on = useFlag('agent');
  const queue = useReadyQueue({ enabled: on });
  const item = queue.data?.items.find((i) => i.jobId === jobId) ?? null;

  if (!on) return status === 'loading' ? null : <ReadyUnavailable />;
  if (isUnavailable(queue.error)) return <ReadyUnavailable />;
  if (queue.isLoading) {
    return (
      <p className={styles.muted} role="status">
        {t('loading')}
      </p>
    );
  }
  if (queue.isError) {
    return <EmptyState title={t('error.title')} sub={t('error.sub')} action={<Btn onClick={() => void queue.refetch()}>{t('error.retry')}</Btn>} />;
  }
  if (!item) return <NotOnList jobId={jobId} />;
  return <Kit item={item} />;
}

function NotOnList({ jobId }: { jobId: string }) {
  const t = useTranslations('ready');
  const { status, add } = useAddToReady(jobId);
  return (
    <EmptyState
      title={t('review.notOnList.title')}
      sub={status === 'full' ? t('review.notOnList.full') : status === 'error' ? t('review.notOnList.failed') : t('review.notOnList.sub')}
      action={
        <div className={styles.row}>
          <Btn variant="primary" onClick={() => void add()} disabled={status === 'adding' || status === 'added'}>
            {t('review.notOnList.add')}
          </Btn>
          <Link href="/ready" className="btn ghost">
            {t('review.back')}
          </Link>
        </div>
      }
    />
  );
}

function Kit({ item }: { item: ReadyQueueItem }) {
  const t = useTranslations('ready');
  const router = useRouter();
  const job = useJob(item.jobId);
  const settings = useAgentSettings();
  const profile = useProfile();
  const actions = useKitActions(item.id);
  // Kit parts only for a kit that was prepared: never for a job still to
  // prepare, being prepared, no longer listed or skipped.
  const showReview = !canPrepare(item.state) && item.state !== 'preparing' && item.state !== 'expired' && item.state !== 'skipped';
  // The kit's review read (WP-52): resume / letter / AI availability / history.
  // Missing or failing → the parts fall back to the list item (never guessed).
  const detailQ = useKitDetail(item.id, { enabled: showReview });
  const detail = detailQ.data ?? null;
  const aiOk = useKitAiAvailable(detail, detail?.kit.resume.variantId ?? item.resumeVariantId);
  const [preparing, setPreparing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const summary = jobSummaryOf(item);
  const title = job.data?.job.title ?? summary?.title ?? t('row.unknownJob');
  const company = job.data?.job.companyName ?? (summary?.companyName || null);
  const failedReason = item.state === 'failed' ? failedReasonOf(lastErrorOf(item)) : null;
  const fit = job.data?.fit ?? null;
  const name = [profile.data?.firstName, profile.data?.lastName].filter(Boolean).join(' ') || null;

  const onPrepared = (r: PrepareRunResult) => {
    if (r.prepared.length > 0) toast({ message: t('prepare.started', { count: r.prepared.length }), tone: 'ok' });
  };
  const onRemove = async () => {
    setActionError(null);
    try {
      await actions.remove();
    } catch (err) {
      setActionError(t(kitErrorKey(err)));
      return;
    }
    router.push('/ready');
  };
  const onSkipOrRestore = async (action: 'skip' | 'restore') => {
    setActionError(null);
    try {
      await actions[action]();
    } catch (err) {
      setActionError(t(kitErrorKey(err)));
    }
  };

  return (
    <div className={styles.page} data-testid="kit-review" data-state={item.state}>
      <p className={styles.muted}>
        <Link href="/ready" className={styles.linkButton}>
          {t('review.back')}
        </Link>
      </p>
      <PageHeader
        title={title}
        sub={
          <span className={styles.row}>
            {company ? <span>{company}</span> : null}
            <Pill tone={STATE_TONE[item.state]}>{t(`state.${item.state}`)}</Pill>
            {fit ? <FitTierLabel tier={fit.tier} score={fit.score} /> : null}
          </span>
        }
      />
      <HonestyLine kind="you_submit" />

      {canPrepare(item.state) ? (
        <section className={styles.card} data-testid="kit-not-prepared">
          <p className={styles.body}>{item.state === 'failed' ? t('review.failed') : t('review.notPrepared')}</p>
          {failedReason ? (
            <p className={styles.muted} data-testid="kit-failed-reason">
              {t(`review.failedReason.${failedReason}`)}
            </p>
          ) : null}
          <div className={styles.row}>
            <Btn variant="primary" onClick={() => setPreparing(true)}>
              {item.state === 'failed' ? t('row.retry') : t('review.prepare')}
            </Btn>
          </div>
        </section>
      ) : null}
      {item.state === 'preparing' ? (
        <p className={styles.cardSoft} role="status" data-testid="kit-preparing">
          {t('review.preparing')}
        </p>
      ) : null}
      {item.state === 'skipped' ? (
        <section className={styles.cardSoft} data-testid="kit-skipped">
          <p className={styles.body}>{t('review.skipped')}</p>
          <div className={styles.row}>
            <Btn onClick={() => void onSkipOrRestore('restore')} disabled={actions.pending !== null}>
              {t('row.restore')}
            </Btn>
          </div>
        </section>
      ) : null}
      {item.state === 'expired' ? (
        <section className={styles.cardWarn} data-testid="kit-expired">
          <p className={styles.body}>{t('review.expired')}</p>
          <div className={styles.row}>
            <Btn onClick={() => void onRemove()}>{t('row.remove')}</Btn>
          </div>
        </section>
      ) : null}

      {showReview ? (
        <div className={styles.review}>
          <div className={styles.stack}>
            <KitResumePart item={item} jobId={item.jobId} detail={detail} aiOk={aiOk} />
            <KitLetterPart item={item} coverLetterMode={settings.data?.coverLetterMode ?? null} aiOk={aiOk} />
            <KitAnswersPart item={item} />
          </div>
          <aside className={styles.aside}>
            <KitOpenPart item={item} jobApplyUrl={job.data?.job.applyUrl ?? null} jobLoading={job.isLoading} />
            <KitFilesPart item={item} detail={detail} style={settings.data?.fileNameStyle ?? null} parts={{ name, company, role: job.data?.job.title ?? null }} />
            <KitPracticePart item={item} />
            <KitHistoryPart item={item} detail={detail} />
          </aside>
        </div>
      ) : (
        <KitHistoryPart item={item} />
      )}

      {actionError ? (
        <p className={styles.error} role="alert">
          {actionError}
        </p>
      ) : null}
      {item.state !== 'opened' && item.state !== 'applied' ? (
        <div className={styles.footer}>
          {item.state !== 'skipped' && item.state !== 'expired' ? (
            <Btn variant="ghost" onClick={() => void onSkipOrRestore('skip')} disabled={actions.pending !== null}>
              {t('review.skip')}
            </Btn>
          ) : (
            <span />
          )}
          {confirmRemove ? (
            <span className={styles.row}>
              <span className={styles.body}>{t('review.removeConfirm')}</span>
              <Btn onClick={() => void onRemove()} disabled={actions.pending !== null}>
                {t('review.removeYes')}
              </Btn>
              <Btn variant="ghost" onClick={() => setConfirmRemove(false)}>
                {t('review.cancel')}
              </Btn>
            </span>
          ) : (
            <Btn variant="ghost" onClick={() => setConfirmRemove(true)}>
              {t('review.remove')}
            </Btn>
          )}
        </div>
      ) : null}

      <PrepareSheet open={preparing} ids={[item.id]} onClose={() => setPreparing(false)} onDone={onPrepared} />
    </div>
  );
}
