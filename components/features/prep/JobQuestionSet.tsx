'use client';

// JobQuestionSet — practice questions for one job (F-INT-01; WP-59):
//   • AI questions written from the job post (and the titles of the company's
//     other open posts), each labelled "Written by AI from the job post — not
//     reported by candidates" and never attributed to the company. They are
//     written only when the user asks ("Write practice questions…"); opening
//     the page never calls a model.
//   • moderated user reports about the company, with their month.
//   • "Practice for this job" on the set (/practice?job=<id>).

import { useTranslations, useFormatter } from 'next-intl';

import { Btn } from '../../v3/primitives/Btn';
import { practiceHref } from '../../../hooks/shared/useLaunchPractice';
import { useGenerateJobQuestions, useJobQuestions } from '../../../hooks/prep/usePrep';
import { PhoneBindingNotice } from '../auth-cn';
import { prepErrorKey } from './errors';
import { QuestionCard } from './QuestionCard';
import styles from './prep.module.css';

export function companyHref(slug: string): string {
  return `/practice/questions/${encodeURIComponent(slug)}`;
}

export function JobQuestionSet({ jobId }: { jobId: string }) {
  const t = useTranslations('practiceQuestions.job');
  const tErr = useTranslations('practiceQuestions.errors');
  const format = useFormatter();
  const set = useJobQuestions(jobId);
  const write = useGenerateJobQuestions(jobId);

  if (set.isLoading) {
    return (
      <section className={styles.section} aria-busy="true">
        <p className={styles.muted}>{t('loading')}</p>
      </section>
    );
  }
  if (set.isError || !set.data) {
    return (
      <section className={styles.section}>
        <p className={styles.error} role="alert">
          {prepErrorKey(set.error) === 'notFound' ? t('notFound') : t('loadError')}
        </p>
      </section>
    );
  }

  const data = write.data ?? set.data;
  const errKey = write.isError ? prepErrorKey(write.error) : null;
  const generatedAt = data.generatedAt ? new Date(data.generatedAt) : null;
  const headingId = `job-set-${jobId}`;

  return (
    <section className={`${styles.section} ${styles.intro}`} aria-labelledby={headingId} data-testid="job-question-set">
      <div className={styles.sectionHead}>
        <div>
          <h2 className={styles.h2} id={headingId}>
            {t('title', { title: data.jobTitle })}
          </h2>
          {data.companyName ? <p className={styles.muted}>{t('sub', { company: data.companyName })}</p> : null}
        </div>
        <Btn as="a" href={practiceHref({ jobId: data.jobId, from: 'questions' })} variant="primary">
          {t('practice')}
        </Btn>
      </div>

      <div className={styles.sectionHead}>
        <h3 className={styles.h3}>{t('aiHeading')}</h3>
        {generatedAt && !Number.isNaN(generatedAt.getTime()) ? <p className={styles.muted}>{t('writtenOn', { date: format.dateTime(generatedAt, { dateStyle: 'medium' }) })}</p> : null}
      </div>

      {data.aiQuestions.length ? (
        <ul className={styles.list}>
          {data.aiQuestions.map((q) => (
            <li key={q.id}>
              <QuestionCard question={q} />
            </li>
          ))}
        </ul>
      ) : data.status === 'ai_unavailable' ? (
        <p className={styles.muted}>{t('aiOff')}</p>
      ) : (
        <div className={styles.actions}>
          <p className={styles.muted}>{t('notWritten')}</p>
          <Btn onClick={() => write.mutate()} disabled={write.isPending} aria-busy={write.isPending}>
            {write.isPending ? t('writing') : t('write')}
          </Btn>
        </div>
      )}
      {errKey ? (
        errKey === 'phone' ? (
          <PhoneBindingNotice error={write.error} />
        ) : (
          <p className={errKey === 'generic' ? styles.error : styles.muted} role="alert">
            {tErr(errKey === 'limit' ? 'jobSetLimit' : errKey)}
          </p>
        )
      ) : null}

      <div className={styles.sectionHead}>
        <h3 className={styles.h3}>{t('reportsHeading', { company: data.companyName || t('thisCompany') })}</h3>
        {data.companySlug && data.companyReports.length ? (
          <a className={styles.link} href={companyHref(data.companySlug)}>
            {t('seeAll', { company: data.companyName })}
          </a>
        ) : null}
      </div>
      {data.companyReports.length ? (
        <ul className={styles.list}>
          {data.companyReports.map((q) => (
            <li key={q.id}>
              <QuestionCard question={q} />
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.muted}>{t('noReports', { company: data.companyName || t('thisCompany') })}</p>
      )}
    </section>
  );
}
