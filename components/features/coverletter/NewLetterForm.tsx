'use client';

// NewLetterForm — "Write a cover letter" (WP-37; PRODUCT_PLAN.md F-CL-01).
//
// Inputs: the job (a job id from the job page, or a pasted post), the resume
// to write from, tone (Plain · Warm · Formal), length (Short · Standard) and,
// on GoApply, the language (中文, or English for 外企). The credit cost is
// shown before the click; the out-of-credits sheet opens from the credit
// gate. While the AI is off for the user (consent, or no model for the
// brand) the form says so and offers no write action.

import { useMemo, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';

import { Btn, CreditNotice } from '../../v3/primitives';
import { useBrand } from '../../../lib/brand';
import { useResumeList } from '../../../hooks/useResumes';
import { useCreateCoverLetter, useLetterJob, type LetterErrorKind } from '../../../hooks/coverletter/useCoverLetters';
import type { CoverLetterView, LetterLength, LetterLocale, LetterTone } from '../../../lib/api/contracts/coverletter';
import { PhoneBindingNotice } from '../auth-cn';
import { LetterError } from './LetterError';
import styles from './CoverLetter.module.css';

export interface NewLetterFormProps {
  /** The job the letter is for; without one the user pastes the post. */
  jobId?: string | null;
  /** Attach the new letter to this application. */
  trackerEntryId?: string | null;
  /** False when AI writing is off for this user. */
  aiAvailable: boolean;
  onCreated: (letter: CoverLetterView) => void;
  onCancel?: () => void;
}

const TONES: readonly LetterTone[] = ['plain', 'warm', 'formal'];
const LENGTHS: readonly LetterLength[] = ['short', 'standard'];
const MIN_JD = 50;

export function NewLetterForm({ jobId, trackerEntryId, aiAvailable, onCreated, onCancel }: NewLetterFormProps) {
  const t = useTranslations('coverLetter');
  const brand = useBrand();
  const cn = brand.market === 'cn';
  const resumes = useResumeList();
  const job = useLetterJob(jobId);
  const create = useCreateCoverLetter();

  const list = useMemo(() => resumes.data?.resumes ?? [], [resumes.data]);
  const primary = list.find((r) => r.isPrimary) ?? list[0];
  const [resumeId, setResumeId] = useState<string>('');
  const chosenResume = resumeId || primary?.id || '';
  const [tone, setTone] = useState<LetterTone>('plain');
  const [length, setLength] = useState<LetterLength>('standard');
  const [locale, setLocale] = useState<LetterLocale>(cn ? 'zh' : 'en');
  const [jd, setJd] = useState({ title: '', company: '', text: '' });
  const [error, setError] = useState<{ kind: LetterErrorKind; cause?: unknown } | null>(null);

  const jdReady = jd.title.trim().length > 0 && jd.text.trim().length >= MIN_JD;
  const canSubmit = aiAvailable && Boolean(chosenResume) && (Boolean(jobId) || jdReady) && !create.pending;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setError(null);
    const r = await create.run({
      ...(jobId ? { jobId } : { jd: { title: jd.title.trim(), company: jd.company.trim(), text: jd.text.trim() } }),
      resumeVariantId: chosenResume,
      tone,
      length,
      ...(cn ? { locale } : {}),
      ...(trackerEntryId ? { trackerEntryId } : {}),
    });
    if (r.ok) onCreated(r.letter);
    else setError({ kind: r.error, cause: r.cause });
  }

  return (
    <form className={`${styles.card} ${styles.stack}`} onSubmit={submit} aria-labelledby="cl-new-title" noValidate>
      <h2 id="cl-new-title" className={styles.cardTitle}>
        {t('form.title')}
      </h2>

      {!aiAvailable ? <p className={styles.notice}>{t('ai.off')}</p> : null}

      <div className={styles.field}>
        <span className={styles.label}>{t('form.jobLabel')}</span>
        {jobId ? (
          <p className={styles.body} data-testid="cl-job">
            {job.data ? t('form.forJob', { title: job.data.title, company: job.data.company }) : t('form.forChosenJob')}
          </p>
        ) : (
          <div className={styles.stack}>
            <p className={styles.hint}>{t('form.pasteIntro')}</p>
            <label className={styles.field}>
              <span className={styles.label}>{t('form.jdTitle')}</span>
              <input className={styles.input} value={jd.title} maxLength={200} onChange={(e) => setJd({ ...jd, title: e.target.value })} />
            </label>
            <label className={styles.field}>
              <span className={styles.label}>{t('form.jdCompany')}</span>
              <input className={styles.input} value={jd.company} maxLength={200} onChange={(e) => setJd({ ...jd, company: e.target.value })} />
            </label>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="cl-jd-text">
                {t('form.jdText')}
              </label>
              <textarea
                id="cl-jd-text"
                className={styles.textarea}
                value={jd.text}
                maxLength={60_000}
                onChange={(e) => setJd({ ...jd, text: e.target.value })}
                aria-describedby="cl-jd-hint"
              />
              <span id="cl-jd-hint" className={styles.hint}>
                {t('form.jdTextHint')}
              </span>
            </div>
          </div>
        )}
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="cl-resume">
          {t('form.resumeLabel')}
        </label>
        {resumes.isLoading ? (
          <span className={styles.hint}>{t('form.resumeLoading')}</span>
        ) : resumes.isError ? (
          // The list failed: say so and offer a retry. Never "add a resume
          // first" — the user may have several.
          <div className={styles.stack} data-testid="cl-resume-error">
            <p className={styles.error} role="alert">
              {t('form.resumeError')}
            </p>
            <div className={styles.actions}>
              <Btn type="button" variant="ghost" onClick={() => void resumes.refetch()} disabled={resumes.isFetching}>
                {t('form.resumeRetry')}
              </Btn>
            </div>
          </div>
        ) : list.length === 0 ? (
          <span className={styles.notice}>
            {t('form.noResume')}{' '}
            <a href="/resume/new" className={styles.backLink}>
              {t('form.addResume')}
            </a>
          </span>
        ) : (
          <select id="cl-resume" className={styles.select} value={chosenResume} onChange={(e) => setResumeId(e.target.value)}>
            {list.map((r) => (
              <option key={r.id} value={r.id}>
                {r.isPrimary ? t('form.resumePrimary', { name: r.name }) : r.name}
              </option>
            ))}
          </select>
        )}
      </div>

      <fieldset className={styles.field}>
        <legend className={styles.label}>{t('tone.label')}</legend>
        <div className={styles.choices}>
          {TONES.map((v) => (
            <label key={v} className={styles.choice}>
              <input type="radio" name="cl-tone" value={v} checked={tone === v} onChange={() => setTone(v)} />
              <span>
                <span className={styles.choiceName}>{t(`tone.${v}`)}</span>
                <span className={styles.hint}>{t(`tone.${v}Hint`)}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className={styles.field}>
        <legend className={styles.label}>{t('length.label')}</legend>
        <div className={styles.choices}>
          {LENGTHS.map((v) => (
            <label key={v} className={styles.choice}>
              <input type="radio" name="cl-length" value={v} checked={length === v} onChange={() => setLength(v)} />
              <span>
                <span className={styles.choiceName}>{t(`length.${v}`)}</span>
                <span className={styles.hint}>{t(`length.${v}Hint`)}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {cn ? (
        <div className={styles.field}>
          <label className={styles.label} htmlFor="cl-lang">
            {t('language.label')}
          </label>
          <select id="cl-lang" className={styles.select} value={locale} onChange={(e) => setLocale(e.target.value as LetterLocale)} aria-describedby="cl-lang-hint">
            <option value="zh">{t('language.zh')}</option>
            <option value="en">{t('language.en')}</option>
          </select>
          <span id="cl-lang-hint" className={styles.hint}>
            {t('language.hint')}
          </span>
        </div>
      ) : null}

      <p className={styles.muted}>{t('form.honesty')}</p>
      <p className={styles.muted}>{t('form.neverSent')}</p>

      {error ? (
        <>
          <PhoneBindingNotice error={error.cause} />
          {error.kind !== 'phone_binding_required' ? <LetterError kind={error.kind} /> : null}
        </>
      ) : null}

      {create.pending ? (
        <p className={styles.notice} role="status" aria-live="polite">
          {t('form.writing')}
        </p>
      ) : null}

      {aiAvailable ? <CreditNotice bucket={create.summary} /> : null}

      <div className={styles.actions}>
        {aiAvailable ? (
          <Btn type="submit" variant="primary" disabled={!canSubmit} aria-busy={create.pending}>
            {t('form.submit')}
          </Btn>
        ) : null}
        {onCancel ? (
          <Btn type="button" variant="ghost" onClick={onCancel}>
            {t('form.cancel')}
          </Btn>
        ) : null}
      </div>
    </form>
  );
}
