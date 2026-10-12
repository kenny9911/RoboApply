'use client';

// TailorTarget — "Which job is this for?" (INT-10; PRODUCT_PLAN.md F-RES-09).
// The first step when the tailor flow starts without a job (the editor's
// Tailor button):
//   - pick one of the user's own saved or applied jobs (the applications
//     tracker; nothing is searched), or
//   - paste the posting: job title, company (optional) and the posting text
//     (at least 50 characters, the server's rule for a pasted posting).
// The choice becomes `jobId` or `jd: { title, company, text }` on the tailor
// session. Nothing here applies to a job (D1).

import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Btn } from '../../v3/primitives';
import { useTailorTargets, type TailorTargetJob } from '../../../hooks/tailor';
import styles from './Tailor.module.css';

/** Limits of a pasted posting (server `JdSnapshotSchema`). */
export const POSTING_TITLE_MAX = 200;
export const POSTING_COMPANY_MAX = 200;
export const POSTING_TEXT_MIN = 50;
export const POSTING_TEXT_MAX = 60_000;

export interface PastedPosting {
  title: string;
  company: string;
  text: string;
}

export type TailorTargetValue = { kind: 'job'; jobId: string; title: string; company: string | null } | { kind: 'posting'; jd: PastedPosting };

export interface TailorTargetProps {
  onPick: (target: TailorTargetValue) => void;
}

/** A pasted posting ready to send, or null while it is incomplete. */
export function postingOf(title: string, company: string, text: string): PastedPosting | null {
  const jd = { title: title.trim(), company: company.trim(), text: text.trim() };
  if (!jd.title || jd.title.length > POSTING_TITLE_MAX) return null;
  if (jd.company.length > POSTING_COMPANY_MAX) return null;
  if (jd.text.length < POSTING_TEXT_MIN || jd.text.length > POSTING_TEXT_MAX) return null;
  return jd;
}

export function TailorTarget({ onPick }: TailorTargetProps) {
  const t = useTranslations('tailor.target');
  const tErr = useTranslations('tailor.error');
  const saved = useTailorTargets();
  const [title, setTitle] = useState('');
  const [company, setCompany] = useState('');
  const [text, setText] = useState('');
  const titleId = useId();
  const companyId = useId();
  const textId = useId();
  const hintId = useId();
  const posting = postingOf(title, company, text);
  const textLength = text.trim().length;
  const jobs: TailorTargetJob[] = saved.data ?? [];

  return (
    <div className={styles.flow} data-step="target">
      <div>
        <p className={styles.heading}>{t('title')}</p>
        <p className={styles.sub}>{t('sub')}</p>
      </div>

      <section className={styles.section} aria-labelledby={`${titleId}-saved`}>
        <p className={styles.label} id={`${titleId}-saved`}>
          {t('savedTitle')}
        </p>
        {saved.isLoading ? (
          <p className={styles.sub} role="status">
            {t('savedLoading')}
          </p>
        ) : saved.isError ? (
          <>
            <p className={styles.sub}>{t('savedError')}</p>
            <div className={styles.actions}>
              <Btn onClick={() => void saved.refetch()}>{tErr('retry')}</Btn>
            </div>
          </>
        ) : jobs.length === 0 ? (
          <p className={styles.sub}>{t('savedEmpty')}</p>
        ) : (
          <ul className={`${styles.picks} ${styles.targetList}`}>
            {jobs.map((job) => (
              <li key={job.jobId}>
                <button type="button" className={styles.pick} onClick={() => onPick({ kind: 'job', jobId: job.jobId, title: job.title, company: job.company })}>
                  <span>{job.title}</span>
                  {job.company ? <span className={styles.sub}>{job.company}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <form
        className={styles.section}
        aria-labelledby={`${titleId}-paste`}
        onSubmit={(e) => {
          e.preventDefault();
          if (posting) onPick({ kind: 'posting', jd: posting });
        }}
      >
        <p className={styles.label} id={`${titleId}-paste`}>
          {t('pasteTitle')}
        </p>
        <label className={styles.sub} htmlFor={titleId}>
          {t('jobTitleLabel')}
        </label>
        <input id={titleId} className={styles.input} value={title} maxLength={POSTING_TITLE_MAX} autoComplete="off" onChange={(e) => setTitle(e.target.value)} />
        <label className={styles.sub} htmlFor={companyId}>
          {t('companyLabel')}
        </label>
        <input id={companyId} className={styles.input} value={company} maxLength={POSTING_COMPANY_MAX} autoComplete="off" onChange={(e) => setCompany(e.target.value)} />
        <label className={styles.sub} htmlFor={textId}>
          {t('textLabel')}
        </label>
        <textarea
          id={textId}
          className={`${styles.textarea} ${styles.posting}`}
          value={text}
          maxLength={POSTING_TEXT_MAX}
          aria-describedby={hintId}
          onChange={(e) => setText(e.target.value.slice(0, POSTING_TEXT_MAX))}
        />
        <span id={hintId} className={styles.counter} aria-live="polite">
          {textLength > 0 && textLength < POSTING_TEXT_MIN ? t('textShort', { min: POSTING_TEXT_MIN, count: textLength }) : t('textHint')}
        </span>
        <div className={styles.actions}>
          <Btn variant="primary" type="submit" disabled={!posting}>
            {t('continue')}
          </Btn>
        </div>
      </form>
    </div>
  );
}
