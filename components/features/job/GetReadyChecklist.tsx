'use client';

// GetReadyChecklist — "Get ready for this job" (PRODUCT F-JOB-03, ruling C43):
// Saved → Resume tailored → Practiced → Applied, each with its next action
// and, for AI actions, what it costs from the server's credit summary
// (never computed here, never "unlimited"). Steps we cannot observe say so
// instead of guessing (Practiced: sessions are not linked to jobs yet).
// AI actions (tailor, cover letter, practice) need `ai.text`: GoApply
// without a configured domestic model shows no entry to them (R-04/R-13);
// links to things already made stay.

import type { ReactNode } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { CreditNotice } from '../../v3/primitives';
import { FillWithExtensionButton } from '../extension';
import { useCredits, bucketSummary } from '../../../hooks/shared/useCredits';
import { useAddToReady } from '../../../hooks/job';
import { cn } from '../../../lib/utils';
import type { JobDetailResponse } from '../../../lib/api/contracts/jobs/detail';
import styles from './job.module.css';

export interface GetReadyChecklistProps {
  detail: JobDetailResponse;
  /** `ai` = the brand's text model is usable (`ai.text`). */
  flags: { interviewBank: boolean; extension: boolean; agent: boolean; people: boolean; ai: boolean };
  pending: string | null;
  onSave: () => void;
  onTailor: () => void;
  onPractice: () => void;
  onApply: () => void;
  onIApplied: () => void;
  onPeople: () => void;
}

type StepState = 'done' | 'todo' | 'unknown';

function Step({ name, state, children }: { name: string; state: StepState; children?: ReactNode }) {
  const t = useTranslations('jobDetail.checklist');
  return (
    <li className={styles.step} data-step-state={state}>
      <div className={styles.stepHead}>
        <span className={styles.stepName}>{name}</span>
        <span className={cn(styles.stepState, state === 'done' && styles.stepDone)}>{t(state)}</span>
      </div>
      {children ? <div className={styles.stepActions}>{children}</div> : null}
    </li>
  );
}

/** The company's practice-question page; with `jobId` it opens that job's AI set first (WP-59; Wave 4 gate). */
export function practiceQuestionsHref(company: { slug: string | null; name: string }, jobId?: string): string {
  const base = `/practice/questions/${encodeURIComponent(company.slug ?? company.name)}`;
  return jobId ? `${base}?job=${encodeURIComponent(jobId)}` : base;
}

export function GetReadyChecklist({ detail, flags, pending, onSave, onTailor, onPractice, onApply, onIApplied, onPeople }: GetReadyChecklistProps) {
  const t = useTranslations('jobDetail.checklist');
  const ta = useTranslations('jobDetail.actions');
  const { job, company, checklist } = detail;
  const credits = useCredits();
  const summary = credits.data?.summary ?? null;
  const practice = credits.data?.practice ?? null;
  const ready = useAddToReady(job.id);
  const open = job.status === 'open';
  const companyName = company.name || job.companyName;

  return (
    <section className={styles.section} aria-labelledby={`ready-${job.id}`} data-testid="job-checklist">
      <h2 id={`ready-${job.id}`} className={styles.sectionTitle}>
        {t('title')}
      </h2>
      <ol className={styles.steps}>
        <Step name={t('step.saved')} state={checklist.saved ? 'done' : 'todo'}>
          {!checklist.saved ? (
            <button type="button" className={styles.stepAction} onClick={onSave} disabled={pending === 'save'}>
              {t('save')}
            </button>
          ) : null}
        </Step>

        <Step name={t('step.tailored')} state={checklist.tailoredResumeId ? 'done' : 'todo'}>
          {checklist.tailoredResumeId ? (
            <Link className={styles.stepAction} href={`/resume/${encodeURIComponent(checklist.tailoredResumeId)}`}>
              {t('openTailored')}
            </Link>
          ) : flags.ai ? (
            <>
              <button type="button" className={styles.stepAction} onClick={onTailor}>
                {t('tailor')}
              </button>
              <CreditNotice bucket={bucketSummary(summary, 'tailor')} />
            </>
          ) : null}
          {checklist.coverLetterId ? (
            <Link className={styles.stepAction} href={`/resume/letters/${encodeURIComponent(checklist.coverLetterId)}`}>
              {t('openCoverLetter')}
            </Link>
          ) : flags.ai ? (
            <>
              <Link className={styles.stepAction} href={`/resume/letters?job=${encodeURIComponent(job.id)}`}>
                {t('coverLetter')}
              </Link>
              <CreditNotice bucket={bucketSummary(summary, 'cover_letter')} />
            </>
          ) : null}
        </Step>

        <Step name={t('step.practiced')} state={checklist.practiced === null ? 'unknown' : checklist.practiced ? 'done' : 'todo'}>
          {flags.ai ? (
            <>
              <button type="button" className={styles.stepAction} onClick={onPractice}>
                {t('practice')}
              </button>
              <p className={styles.muted}>{practice ? t('practiceCredits', { count: practice.balance }) : t('practiceCreditsUnknown')}</p>
            </>
          ) : null}
          {flags.interviewBank ? (
            <Link className={styles.stepAction} href={practiceQuestionsHref({ slug: company.slug, name: companyName }, job.id)}>
              {t('practiceQuestions', { company: companyName })}
            </Link>
          ) : null}
          {flags.people ? (
            <button type="button" className={styles.stepAction} onClick={onPeople}>
              {t('people', { company: companyName })}
            </button>
          ) : null}
          {checklist.practiced === null ? <p className={styles.muted}>{t('practiceNotLinked')}</p> : null}
        </Step>

        <Step name={t('step.applied')} state={checklist.applied ? 'done' : 'todo'}>
          {!checklist.applied ? (
            <>
              {flags.agent && open ? (
                <button type="button" className={styles.stepAction} onClick={() => void ready.add()} disabled={ready.status === 'adding' || ready.status === 'added'}>
                  {ready.status === 'adding' ? t('addingToReady') : ready.status === 'added' ? t('addedToReady') : t('addToReady')}
                </button>
              ) : null}
              {ready.status === 'full' ? <p className={styles.alert}>{t('readyFull')}</p> : null}
              {ready.status === 'error' ? <p className={styles.alert}>{t('readyError')}</p> : null}
              {flags.extension && open ? <FillWithExtensionButton jobId={job.id} applyUrl={job.applyUrl} /> : null}
              {open && job.applyUrl ? (
                <button type="button" className={styles.stepAction} onClick={onApply} disabled={pending === 'apply'}>
                  {ta('apply')}
                </button>
              ) : null}
              <button type="button" className={styles.stepAction} onClick={onIApplied} disabled={pending === 'markApplied'}>
                {ta('iApplied')}
              </button>
            </>
          ) : null}
        </Step>
      </ol>
    </section>
  );
}
