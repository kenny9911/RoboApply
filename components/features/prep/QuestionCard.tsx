'use client';

// QuestionCard — one practice question with its source line on every item
// (D3; WP-59). The source line says where the question came from:
//   user_report  "Shared by a %BRAND% user, {month year}"
//   ai_practice  "Written by AI from the job post — not reported by candidates" (+ AiGeneratedBadge on GoApply)
//   curated      "Written by %BRAND% staff — not reported by candidates"
// "How to answer" opens the guide; when none exists yet it is written on this
// first view (AI, labelled, 30/day), unless AI is off for the user.
// "Report" sends a reason; enough reports hide a question until staff look.

import { useEffect, useId, useState, type FormEvent } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import { Btn } from '../../v3/primitives/Btn';
import { AiGeneratedBadge } from '../market';
import { apiErrorCode } from '../../../lib/api/contracts/wire';
import type { QuestionGuide, QuestionView } from '../../../lib/api/contracts/prep';
import { useGenerateGuide, useQuestionDetail, useReportQuestion } from '../../../hooks/prep/usePrep';
import { PhoneBindingNotice } from '../auth-cn';
import { prepErrorKey } from './errors';
import styles from './prep.module.css';

const REPORT_REASONS = ['wrong', 'duplicate', 'offensive', 'confidential', 'other'] as const;

/** "2026-08" → "August 2026" in the viewer's locale; null when malformed. */
export function usePeriodLabel() {
  const format = useFormatter();
  return (period: string | null | undefined): string | null => {
    const m = period ? /^(\d{4})-(\d{2})$/.exec(period) : null;
    if (!m) return null;
    return format.dateTime(new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 15)), { year: 'numeric', month: 'long', timeZone: 'UTC' });
  };
}

export function SourceLine({ question }: { question: Pick<QuestionView, 'sourceKind' | 'sourceLabelKey' | 'reportedPeriod'> }) {
  const t = useTranslations('practiceQuestions');
  const period = usePeriodLabel()(question.reportedPeriod);
  const label =
    question.sourceKind === 'user_report'
      ? period
        ? t('source.userReport', { period })
        : t('source.userReportNoDate')
      : question.sourceKind === 'ai_practice'
        ? t('source.aiPractice')
        : t('source.curated');
  return (
    <p className={`${styles.source} ${question.sourceKind === 'ai_practice' ? styles.sourceAi : ''}`} data-source-kind={question.sourceKind}>
      {question.sourceKind === 'ai_practice' ? <AiGeneratedBadge kind="text" /> : null}
      <span>{label}</span>
    </p>
  );
}

function GuideBody({ guide }: { guide: QuestionGuide }) {
  const t = useTranslations('practiceQuestions.card');
  const lists: Array<[keyof QuestionGuide, string]> = [
    ['whatTheyTest', t('whatTheyTest')],
    ['rubric', t('rubric')],
    ['commonMistakes', t('commonMistakes')],
    ['followUps', t('followUps')],
  ];
  return (
    <>
      {guide.approach ? (
        <div className={styles.guideBlock}>
          <h4 className={styles.h3}>{t('approach')}</h4>
          <p className={styles.text}>{String(guide.approach)}</p>
        </div>
      ) : null}
      {lists.map(([key, title]) => {
        const items = Array.isArray(guide[key]) ? (guide[key] as unknown[]).filter((v): v is string => typeof v === 'string' && v.length > 0) : [];
        if (!items.length) return null;
        return (
          <div className={styles.guideBlock} key={key}>
            <h4 className={styles.h3}>{title}</h4>
            <ul className={styles.bullets}>
              {items.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          </div>
        );
      })}
    </>
  );
}

function Guide({ id }: { id: string }) {
  const t = useTranslations('practiceQuestions.card');
  const detail = useQuestionDetail(id, true);
  const write = useGenerateGuide(id);
  const status = detail.data?.guideStatus;

  // First view: write the guide once when none exists and AI is on.
  useEffect(() => {
    if (status === 'not_generated' && write.isIdle) write.mutate();
  }, [status, write]);

  const guide = write.data?.guide ?? detail.data?.guide ?? null;
  const errKey = write.isError ? prepErrorKey(write.error) : null;
  const tErr = useTranslations('practiceQuestions.errors');

  return (
    <div className={styles.guide} aria-live="polite">
      {detail.isLoading || write.isPending ? (
        <p className={styles.muted} aria-busy="true">
          {t('guideLoading')}
        </p>
      ) : detail.isError ? (
        <p className={styles.error} role="alert">
          {t('guideError')}
        </p>
      ) : guide ? (
        <>
          <p className={styles.source}>
            <AiGeneratedBadge kind="text" />
            <span>{t('guideAiLine')}</span>
          </p>
          <GuideBody guide={guide} />
        </>
      ) : status === 'ai_unavailable' ? (
        <p className={styles.muted}>{t('guideUnavailable')}</p>
      ) : errKey === 'phone' ? (
        <PhoneBindingNotice error={write.error} />
      ) : errKey ? (
        <div className={styles.actions}>
          <p className={errKey === 'generic' ? styles.error : styles.muted} role="alert">
            {tErr(errKey === 'limit' ? 'guideLimit' : errKey)}
          </p>
          {errKey === 'generic' ? <Btn onClick={() => write.mutate()}>{t('retry')}</Btn> : null}
        </div>
      ) : null}
    </div>
  );
}

function ReportForm({ id, onDone }: { id: string; onDone: () => void }) {
  const t = useTranslations('practiceQuestions.report');
  const report = useReportQuestion(id);
  const [reason, setReason] = useState<(typeof REPORT_REASONS)[number]>('wrong');
  const [note, setNote] = useState('');
  const base = useId();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    report.mutate({ reason, ...(note.trim() ? { note: note.trim() } : {}) });
  };

  if (report.isSuccess) {
    return (
      <p className={styles.success} role="status">
        {report.data.hidden ? t('hidden') : t('sent')}
      </p>
    );
  }

  return (
    <form className={styles.form} onSubmit={submit} aria-label={t('title')}>
      <fieldset className={styles.fieldset}>
        <legend className={styles.label}>{t('reason')}</legend>
        {REPORT_REASONS.map((r) => (
          <label key={r} className={styles.check}>
            <input type="radio" name={`${base}-reason`} value={r} checked={reason === r} onChange={() => setReason(r)} />
            <span>{t(`reasons.${r}`)}</span>
          </label>
        ))}
      </fieldset>
      <div className={styles.field}>
        <label className={styles.label} htmlFor={`${base}-note`}>
          {t('note')}
        </label>
        <textarea id={`${base}-note`} className={styles.textarea} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      {report.isError ? (
        <p className={styles.error} role="alert">
          {apiErrorCode(report.error) === 'rate_limited' ? t('limit') : t('error')}
        </p>
      ) : null}
      <div className={styles.actions}>
        <Btn type="submit" variant="primary" disabled={report.isPending}>
          {t('send')}
        </Btn>
        <Btn onClick={onDone}>{t('cancel')}</Btn>
      </div>
    </form>
  );
}

export interface QuestionCardProps {
  question: QuestionView;
  /** Show the company name in the meta line (lists that mix companies). */
  showCompany?: boolean;
}

export function QuestionCard({ question, showCompany = false }: QuestionCardProps) {
  const t = useTranslations('practiceQuestions');
  const [open, setOpen] = useState(false);
  const [reporting, setReporting] = useState(false);
  const base = useId();
  const titleId = `${base}-title`;
  const guideId = `${base}-guide`;

  return (
    <article className={styles.card} aria-labelledby={titleId} data-testid="question-card" data-source-kind={question.sourceKind}>
      <h3 className={styles.h3} id={titleId}>
        {question.title}
      </h3>
      {question.body && question.body !== question.title ? <p className={styles.text}>{question.body}</p> : null}
      <div className={styles.meta}>
        <span className={styles.tag}>{t(`categories.${question.category}`)}</span>
        {question.difficulty ? <span className={styles.tag}>{t(`difficulty.${question.difficulty}`)}</span> : null}
        {question.seniority ? <span className={styles.tag}>{question.seniority}</span> : null}
        {showCompany && question.companyName ? <span className={styles.tag}>{question.companyName}</span> : null}
      </div>
      <SourceLine question={question} />
      <div className={styles.actions}>
        <button type="button" className={styles.link} aria-expanded={open} aria-controls={guideId} onClick={() => setOpen((v) => !v)}>
          {open ? t('card.hideGuide') : t('card.showGuide')}
        </button>
        {!reporting ? (
          <button type="button" className={styles.link} onClick={() => setReporting(true)}>
            {t('card.report')}
          </button>
        ) : null}
      </div>
      <div id={guideId} hidden={!open}>
        {open ? <Guide id={question.id} /> : null}
      </div>
      {reporting ? <ReportForm id={question.id} onDone={() => setReporting(false)} /> : null}
    </article>
  );
}
